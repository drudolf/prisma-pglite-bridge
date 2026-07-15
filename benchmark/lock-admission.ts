/**
 * Session-lock admission microbenchmark — the pinned yardstick for the
 * admission-reservation tradeoff (plan:
 * .claude/plans/session-lock-admission-reservation.md, amendment of
 * 2026-07-15).
 *
 * Worst case for admission serialization: a max-8 pool firing concurrent
 * tiny point-lookups, so the additive per-admission cost (~+30 µs measured
 * on the reference machine: drain hop + ready-wait + runExclusive enqueue
 * that no longer overlaps the predecessor's execution) is maximal relative
 * to op time. Reservation-vs-baseline reference numbers live in the plan's
 * amendment record; rerun A/B (this tree vs a pre-change worktree,
 * interleaved rounds, medians of run-medians) before optimizing the drain
 * path or accepting any further regression here.
 *
 * Run: pnpm bench:lock
 */
import { PGlite } from '@electric-sql/pglite';
import { PgBridgePool } from '../src/pool/index.ts';

const CLIENTS = 8;
const WARMUP_ROUNDS = 200;
const MEASURE_ROUNDS = 500;
const RUNS = 3;

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? Number.NaN;

const run = async (): Promise<{ p50: number; p99: number; roundsPerSec: number }> => {
  const pglite = new PGlite();
  await pglite.waitReady;
  const pool = new PgBridgePool({ pglite, max: CLIENTS });
  const clients = await Promise.all(Array.from({ length: CLIENTS }, () => pool.connect()));
  await clients[0]?.query('CREATE TABLE t (id int PRIMARY KEY, v text)');
  for (let i = 0; i < 100; i++) {
    await clients[0]?.query('INSERT INTO t VALUES ($1, $2)', [i, `v${i}`]);
  }

  const round = async (record?: number[]): Promise<void> => {
    await Promise.all(
      clients.map(async (client, k) => {
        const start = performance.now();
        await client.query('SELECT v FROM t WHERE id = $1', [(k * 13) % 100]);
        record?.push(performance.now() - start);
      }),
    );
  };

  for (let i = 0; i < WARMUP_ROUNDS; i++) await round();
  const timings: number[] = [];
  const measureStart = performance.now();
  for (let i = 0; i < MEASURE_ROUNDS; i++) await round(timings);
  const elapsedMs = performance.now() - measureStart;

  for (const client of clients) client.release();
  await pool.end();

  timings.sort((a, b) => a - b);
  return {
    p50: pct(timings, 50),
    p99: pct(timings, 99),
    roundsPerSec: (MEASURE_ROUNDS / elapsedMs) * 1000,
  };
};

const results: Array<{ p50: number; p99: number; roundsPerSec: number }> = [];
for (let i = 0; i < RUNS; i++) results.push(await run());
const median = (xs: number[]): number => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
console.log(
  JSON.stringify(
    {
      node: process.version,
      clients: CLIENTS,
      runs: results,
      medianP50Ms: median(results.map((r) => r.p50)),
      medianP99Ms: median(results.map((r) => r.p99)),
      medianRoundsPerSec: median(results.map((r) => r.roundsPerSec)),
    },
    null,
    2,
  ),
);
