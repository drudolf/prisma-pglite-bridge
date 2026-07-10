/**
 * pg-ecosystem compatibility harness — runs each registered probe
 * (pg-cursor, pg-query-stream, LISTEN/NOTIFY, pg-copy-streams,
 * node-pg-migrate, pg-boss, …) against a fresh PGlite + `PgBridgePool`
 * and prints a PASS/FAIL matrix with per-probe details.
 *
 * A FAIL is a report, not a harness error: the run always completes and
 * exits 0 unless the harness itself is broken. Probes get a fresh
 * PGlite instance and pool each, a hard per-probe deadline, and
 * best-effort teardown (a wedged probe is reported and skipped past).
 *
 * Usage:
 *   pnpm bench:compat                 # all probes
 *   pnpm bench:compat --probe pg-cursor
 */
import { PGlite } from '@electric-sql/pglite';
import { PgBridgePool } from '../../src/pool';
import { type CompatProbe, withTimeout } from './types.ts';

const PROBES: Record<string, () => Promise<CompatProbe>> = {
  'pg-cursor': async () => (await import('./pg-cursor.ts')).pgCursor,
  'pg-query-stream': async () => (await import('./pg-query-stream.ts')).pgQueryStream,
  'listen-notify': async () => (await import('./listen-notify.ts')).listenNotify,
  'pg-copy-streams': async () => (await import('./pg-copy-streams.ts')).pgCopyStreams,
  'node-pg-migrate': async () => (await import('./node-pg-migrate.ts')).nodePgMigrate,
  'pg-boss': async () => (await import('./pg-boss.ts')).pgBoss,
};

const PROBE_DEADLINE_MS = 60_000;
const TEARDOWN_DEADLINE_MS = 5_000;

const argv = process.argv.slice(2);
const getArg = (long: string): string | undefined => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === `--${long}`) return argv[i + 1];
  }
  return undefined;
};
const probeFilter = getArg('probe');

type Row = { name: string; summary: string; status: string; details: string[] };

const main = async () => {
  const selected = probeFilter ? [probeFilter] : Object.keys(PROBES);
  console.log('\npg-ecosystem compatibility — PgBridgePool over the wire protocol\n');
  const rows: Row[] = [];

  for (const name of selected) {
    const load = PROBES[name];
    if (!load) {
      throw new Error(`Unknown probe '${name}' — registered: ${Object.keys(PROBES).join(', ')}`);
    }
    const probe = await load();
    process.stdout.write(`▸ ${probe.name}...`);

    const pglite = new PGlite();
    await pglite.waitReady;
    const pool = new PgBridgePool({ pglite });

    // Incompatibilities can surface as ASYNC failures — an unhandled
    // 'error' on a checked-out client, or a FATAL protocol violation
    // (08P01) from PGlite killing the process. Capture them for the
    // probe's duration and fold them into the row instead of dying.
    const asyncErrors: string[] = [];
    const capture = (err: unknown) => {
      asyncErrors.push(err instanceof Error ? err.message : String(err));
    };
    process.on('uncaughtException', capture);
    process.on('unhandledRejection', capture);
    pool.on('error', capture);

    let row: Row;
    try {
      const outcome = await withTimeout(
        PROBE_DEADLINE_MS,
        `probe ${probe.name}`,
        probe.run({ pool, pglite }),
      );
      row = { name: probe.name, summary: probe.summary, ...outcome };
      if (asyncErrors.length > 0 && row.status === 'pass') {
        row.status = 'fail';
        row.details = [...row.details, `async errors during probe: ${asyncErrors.join('; ')}`];
      }
    } catch (err) {
      row = {
        name: probe.name,
        summary: probe.summary,
        status: 'fail',
        details: [
          err instanceof Error ? err.message : String(err),
          ...(asyncErrors.length > 0 ? [`async: ${asyncErrors.join('; ')}`] : []),
        ],
      };
    } finally {
      process.off('uncaughtException', capture);
      process.off('unhandledRejection', capture);
    }
    rows.push(row);
    console.log(` ${row.status.toUpperCase()}`);

    // Best-effort teardown: a wedged probe can leave the session lock
    // held, in which case pool.end()/pglite.close() would hang too.
    try {
      await withTimeout(TEARDOWN_DEADLINE_MS, 'teardown', teardown(pool, pglite));
    } catch {
      console.log(`  (teardown wedged for ${probe.name} — instance leaked, continuing)`);
    }
  }

  const LINE = '─'.repeat(100);
  console.log(`\n${LINE}`);
  console.log('Compatibility matrix\n');
  for (const row of rows) {
    console.log(`${row.status === 'pass' ? 'PASS' : 'FAIL'}  ${row.name.padEnd(18)}${row.summary}`);
    for (const d of row.details) console.log(`      - ${d}`);
  }
  console.log(LINE);
  const passed = rows.filter((r) => r.status === 'pass').length;
  console.log(`${passed}/${rows.length} probes pass`);
};

const teardown = async (pool: PgBridgePool, pglite: PGlite): Promise<void> => {
  if (!(pool as unknown as { ended?: boolean }).ended) await pool.end();
  if (!pglite.closed) await pglite.close();
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
