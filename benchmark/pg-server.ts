#!/usr/bin/env tsx
/**
 * Native-Postgres baseline server for the benchmark suite.
 *
 * Starts an embedded-postgres 18 server matching `BENCH_POSTGRES_URL` from
 * `.env.test` (default `postgres:password@127.0.0.1:5433/bench`), writes the
 * postmaster PID back to `.env.test` as `BENCH_POSTGRES_SERVER_PIDS` (for
 * server-side RSS sampling), and runs until Ctrl-C. Two-terminal flow:
 *
 *   pnpm bench:pg-server                        # terminal 1 — keeps running
 *   pnpm bench --adapter postgres-pg -n 1000    # terminal 2
 *
 * Set BENCH_POSTGRES_SYNC_OFF=1 to start the server with durability disabled
 * (fsync/synchronous_commit/full_page_writes off) — the fairer baseline for
 * write-heavy comparisons against a bridge that has no durability at all.
 *
 * The per-arch Postgres binary comes from `embedded-postgres`; its postinstall
 * hydrates the dylib symlinks and runs on a plain `pnpm install` because the
 * `@embedded-postgres/*` packages are approved in `allowBuilds`
 * (pnpm-workspace.yaml). If it is ever missing, `pnpm rebuild embedded-postgres`
 * rebuilds it.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const ENV_PATH = join(import.meta.dirname, '..', '.env.test');
const DEFAULT_URL = 'postgresql://postgres:password@127.0.0.1:5433/bench';
const DATA_DIR = '/tmp/pg-bench-data';

const readEnv = (): Record<string, string> => {
  if (!existsSync(ENV_PATH)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    if (!line.includes('=') || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf('=');
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
};

const writeEnv = (env: Record<string, string>): void => {
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  writeFileSync(ENV_PATH, `${body}\n`);
};

const env = readEnv();
const connectionString = env.BENCH_POSTGRES_URL ?? DEFAULT_URL;
const url = new URL(connectionString);
const database = url.pathname.replace(/^\//, '') || 'bench';

// A real Postgres pays durability the in-memory bridge and PGlite never do
// (WAL fsync, full-page writes). BENCH_POSTGRES_SYNC_OFF=1 turns those off so
// write-heavy scenarios compare engine speed, not the fsync tax — the fairer
// baseline for a bridge that has no durability at all.
const syncOff = process.env.BENCH_POSTGRES_SYNC_OFF === '1';
const postgresFlags = syncOff
  ? ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off']
  : [];

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: decodeURIComponent(url.username) || 'postgres',
  password: decodeURIComponent(url.password) || 'password',
  port: Number(url.port) || 5433,
  persistent: false,
  postgresFlags,
});

console.log(
  `starting embedded-postgres on ${url.host} (database "${database}")` +
    `${syncOff ? ' [durability off: fsync/synchronous_commit/full_page_writes]' : ''}...`,
);
rmSync(DATA_DIR, { recursive: true, force: true }); // fresh cluster each run

try {
  await pg.initialise();
  await pg.start();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (/Library not loaded|dyld|ENOENT.*postgres/.test(message)) {
    console.error(
      '\nPostgres binary is not built. Run `pnpm install` (or `pnpm rebuild ' +
        'embedded-postgres`) to build it, then retry.\n',
    );
  }
  throw err;
}

try {
  await pg.createDatabase(database);
} catch {
  // already exists on a reused port — fine
}

const pid = readFileSync(join(DATA_DIR, 'postmaster.pid'), 'utf8').split('\n')[0]?.trim() ?? '';
writeEnv({ ...env, BENCH_POSTGRES_URL: connectionString, BENCH_POSTGRES_SERVER_PIDS: pid });

console.log(
  `ready — ${connectionString}  (postmaster pid ${pid})${syncOff ? '  [durability off]' : ''}`,
);
console.log('run the benchmark in another terminal, then Ctrl-C here to stop.');

const stop = async (): Promise<void> => {
  await pg.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30); // keep the process (and the server) alive
