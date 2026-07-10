/**
 * ORM benchmark harness — for each registered ORM, compares its native
 * PGlite driver against the same ORM driving `PgBridgePool` over the
 * PostgreSQL wire protocol, on identical fresh PGlite instances.
 *
 * The workload is fixed here (schema, seeding, warmup, five measured
 * operations, correctness gate) so results are comparable across ORMs;
 * ORM modules only translate operations into their own APIs (see
 * `types.ts` for the contract).
 *
 * Usage:
 *   pnpm bench:orm                          # all ORMs, N=300 w=30
 *   pnpm bench:orm --orm drizzle -n 300 -w 30
 *   pnpm bench:orm -r 3                     # whole-run repeats; p50 spread reported
 */
import { PGlite } from '@electric-sql/pglite';
import { PgBridgePool } from '../../src/pool';
import type { OrmDefinition, OrmOps } from './types.ts';

const ORMS: Record<string, () => Promise<OrmDefinition>> = {
  drizzle: async () => (await import('./drizzle.ts')).drizzle,
  knex: async () => (await import('./knex.ts')).knex,
  kysely: async () => (await import('./kysely.ts')).kysely,
  'mikro-orm': async () => (await import('./mikro-orm.ts')).mikroOrm,
  typeorm: async () => (await import('./typeorm.ts')).typeorm,
};

const DDL = `
CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
CREATE TABLE posts (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), title TEXT NOT NULL);
`;

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const getArg = (long: string, short?: string): string | undefined => {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === `--${long}` || (short && argv[i] === `-${short}`)) return argv[i + 1];
  }
  return undefined;
};

const ormFilter = getArg('orm');
const N = Number(getArg('n', 'n') ?? '300');
const WARMUP = Number(getArg('warmup', 'w') ?? '30');
const REPEAT = Number(getArg('repeat', 'r') ?? '1');

// ─── Timing ───────────────────────────────────────────────────────────────────

const time = async (fn: () => Promise<unknown>): Promise<number> => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};

const pct = (arr: number[], p: number): number => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.ceil((p / 100) * s.length) - 1] ?? 0;
};
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] ?? 0) : ((s[m - 1] ?? 0) + (s[m] ?? 0)) / 2;
};
const fmt = (ms: number) => `${ms.toFixed(2)}ms`;
const col = (s: string, w: number) => s.padEnd(w);

// ─── Correctness gate ─────────────────────────────────────────────────────────

/** Same values back from both paths, and a committed transaction visible
 *  afterwards — run before any timing so a wrong-answer path never gets
 *  benchmarked. */
const checkCorrectness = async (native: OrmOps, wire: OrmOps): Promise<void> => {
  process.stdout.write('  correctness...');

  const email = 'ccheck@bench.com';
  await native.insertUser('CCheck', email);
  await wire.insertUser('CCheck', email);
  const [nRow] = await native.usersByEmail(email);
  const [wRow] = await wire.usersByEmail(email);
  if (JSON.stringify(nRow) !== JSON.stringify(wRow)) {
    throw new Error(
      `select mismatch:\n  native: ${JSON.stringify(nRow)}\n  wire:   ${JSON.stringify(wRow)}`,
    );
  }

  await native.txReadWrite(email, 'TxCheck');
  await wire.txReadWrite(email, 'TxCheck');
  const nTx = (await native.postsJoinUsers()).filter((r) => r.title === 'TxCheck');
  const wTx = (await wire.postsJoinUsers()).filter((r) => r.title === 'TxCheck');
  if (nTx.length !== 1 || wTx.length !== 1) {
    throw new Error(`tx commit mismatch: native=${nTx.length} wire=${wTx.length} (want 1 each)`);
  }

  process.stdout.write(' PASS\n');
};

// ─── Bench runner ─────────────────────────────────────────────────────────────

const SEED_EMAIL = 'seed@bench.com';

const runBench = async (ops: OrmOps, label: string): Promise<Record<string, number[]>> => {
  const results: Record<string, number[]> = {
    'single insert': [],
    findMany: [],
    'select where': [],
    join: [],
    'tx (r+w)': [],
  };

  // Seed a user for where-clause + join queries, and seed some posts.
  await ops.insertUser('Seed', SEED_EMAIL);
  const seedId = await ops.userIdByEmail(SEED_EMAIL);
  if (seedId !== undefined) {
    await ops.insertPost(seedId, 'Seed post 1');
    await ops.insertPost(seedId, 'Seed post 2');
  }

  process.stdout.write(`  [${label}] warmup ${WARMUP}...`);
  for (let i = 0; i < WARMUP; i++) {
    await ops.insertUser(`w${i}`, `w${i}@warm.com`);
    await ops.usersLimit(10);
  }
  process.stdout.write(' done\n');

  process.stdout.write(`  [${label}] N=${N}...`);
  for (let i = 0; i < N; i++) {
    results['single insert']?.push(await time(() => ops.insertUser(`U${i}`, `u${i}@run.com`)));
    results.findMany?.push(await time(() => ops.usersAll()));
    results['select where']?.push(await time(() => ops.usersByEmail(SEED_EMAIL)));
    results.join?.push(await time(() => ops.postsJoinUsers()));
    results['tx (r+w)']?.push(await time(() => ops.txReadWrite(SEED_EMAIL, `P${i}`)));
  }
  process.stdout.write(' done\n');

  return results;
};

// ─── Report ───────────────────────────────────────────────────────────────────

const report = (nRuns: Record<string, number[]>[], wRuns: Record<string, number[]>[]): void => {
  const multi = nRuns.length > 1;
  const p50w = multi ? 26 : 12;
  const LINE = '─'.repeat(multi ? 102 : 74);
  console.log(`\n${LINE}`);
  console.log(
    `Results (ms, lower is better${multi ? `; p50 median [spread] of ${nRuns.length} repeats, p99 median` : ''})\n`,
  );
  console.log(
    col('Operation', 16) +
      col('native p50', p50w) +
      col('wire p50', p50w) +
      col('native p99', 12) +
      col('wire p99', 12) +
      'overhead (p50)',
  );
  console.log(LINE);

  const cell = (p50s: number[]): string => {
    const med = fmt(median(p50s));
    if (!multi) return med;
    return `${med} [${fmt(Math.min(...p50s))}–${fmt(Math.max(...p50s))}]`;
  };

  for (const op of Object.keys(nRuns[0] ?? {})) {
    const nP50s = nRuns.map((r) => pct(r[op] ?? [], 50));
    const wP50s = wRuns.map((r) => pct(r[op] ?? [], 50));
    const nP99 = median(nRuns.map((r) => pct(r[op] ?? [], 99)));
    const wP99 = median(wRuns.map((r) => pct(r[op] ?? [], 99)));
    console.log(
      col(op, 16) +
        col(cell(nP50s), p50w) +
        col(cell(wP50s), p50w) +
        col(fmt(nP99), 12) +
        col(fmt(wP99), 12) +
        `${(median(wP50s) / median(nP50s)).toFixed(1)}×`,
    );
  }
  console.log(LINE);
};

// ─── Main ─────────────────────────────────────────────────────────────────────

const main = async () => {
  const selected = ormFilter ? [ormFilter] : Object.keys(ORMS);
  console.log(`\nORM wire-protocol benchmark — N=${N}, warmup=${WARMUP}\n`);

  for (const name of selected) {
    const load = ORMS[name];
    if (!load) {
      throw new Error(`Unknown ORM '${name}' — registered: ${Object.keys(ORMS).join(', ')}`);
    }
    const def = await load();

    console.log(`═══ ${def.name} ═══`);
    const nRuns: Record<string, number[]>[] = [];
    const wRuns: Record<string, number[]>[] = [];

    // Whole-run repeats: fresh PGlite instances, pool, and ORM per repeat,
    // aggregated in report() as p50 median [min–max spread].
    for (let rep = 1; rep <= REPEAT; rep++) {
      if (REPEAT > 1) console.log(`— repeat ${rep}/${REPEAT} —`);
      console.log(`Setup: native (${def.nativeLabel})...`);
      const nativePglite = new PGlite();
      await nativePglite.waitReady;
      await nativePglite.exec(DDL);
      const nativePath = await def.createNative(nativePglite);

      console.log(`Setup: wire (${def.wireLabel})...`);
      const wirePglite = new PGlite();
      await wirePglite.waitReady;
      await wirePglite.exec(DDL);
      const pool = new PgBridgePool({ pglite: wirePglite });
      const wirePath = await def.createWire(pool);

      console.log('Correctness:');
      await checkCorrectness(nativePath.ops, wirePath.ops);

      console.log('\nNative path:');
      nRuns.push(await runBench(nativePath.ops, 'native'));
      console.log('\nWire path:');
      wRuns.push(await runBench(wirePath.ops, 'wire'));

      await nativePath.end();
      await wirePath.end();
      // Guarded teardown: some ORM teardowns reach into harness-owned
      // resources — knex-pglite closes a caller-supplied PGlite, and
      // MikroORM's kysely client ends the wire pool on orm.close().
      if (!(pool as unknown as { ended?: boolean }).ended) await pool.end();
      if (!wirePglite.closed) await wirePglite.close();
      if (!nativePglite.closed) await nativePglite.close();
    }

    report(nRuns, wRuns);
  }
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
