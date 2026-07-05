/**
 * Focused interactive-transaction benchmark — a high-iteration hot loop over
 * one representative `$transaction` (read → conditional write → read), with
 * per-phase sub-timings so a fat transaction tail can be attributed to the
 * work (an individual statement) or to the transaction machinery itself
 * (BEGIN/COMMIT round-trips plus Prisma's interactive-transaction lock).
 *
 * The aggregate `micro` suite runs interactive tx at only n=60, so its p99 is
 * effectively a single unlucky sample. This isolates the transaction at high n
 * for a stable tail, and the `tx control` row separates the per-round-trip
 * transaction overhead — where the bridge's wire-protocol cost accumulates —
 * from the statements themselves.
 *
 *   NODE_OPTIONS="--expose-gc" pnpm bench --scenario tx-focused -n 2000 -w 200
 *
 * By default the transaction's sorted read hits the Batch.createdAt index.
 * Set BENCH_TX_UNINDEXED=1 to drop that index first and measure the same
 * transaction over a sequential scan — the two together show how much of the
 * bridge-vs-native picture is the missing index vs the engine.
 */
import type { Scenario, ScenarioResult } from '../adapters/types.ts';

const SEED_JOBS = 200;

export const txFocused: Scenario = async (prisma, iterations) => {
  const stamp = Date.now();
  const tenant = await prisma.tenant.create({ data: { name: 'T', slug: `t-${stamp}` } });
  const ws = await prisma.workspace.create({
    data: { name: 'W', slug: 'w', tenantId: tenant.id, apiKey: `k_${stamp}` },
  });
  await prisma.job.createMany({
    data: Array.from({ length: SEED_JOBS }, (_, i) => ({
      friendlyId: `j_${i}_${stamp}`,
      workspaceId: ws.id,
      priority: i % 5,
    })),
  });

  // BENCH_TX_UNINDEXED=1 drops the Batch.createdAt index so the transaction's
  // findFirst(orderBy: createdAt desc) falls back to a sequential scan + sort —
  // the honest "unindexed sort" case, where PGlite's WASM executor pays more
  // than native Postgres. The default (index present) is the realistic case a
  // production schema would have.
  if (process.env.BENCH_TX_UNINDEXED === '1') {
    await prisma.$executeRawUnsafe('DROP INDEX IF EXISTS "Batch_createdAt_idx"');
  }

  if (typeof globalThis.gc === 'function') globalThis.gc();

  const total: number[] = [];
  const readCount: number[] = [];
  const write: number[] = [];
  const readFirst: number[] = [];
  const control: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let rc = 0;
    let wr = 0;
    let rf = 0;
    const t0 = performance.now();
    await prisma.$transaction(async (tx) => {
      const a = performance.now();
      const count = await tx.job.count();
      const b = performance.now();
      await tx.batch.create({
        data: { friendlyId: `tx_${stamp}_${i}`, metadata: { jobCount: count } },
      });
      const c = performance.now();
      await tx.batch.findFirst({ orderBy: { createdAt: 'desc' } });
      const d = performance.now();
      rc = b - a;
      wr = c - b;
      rf = d - c;
    });
    const whole = performance.now() - t0;
    total.push(whole);
    readCount.push(rc);
    write.push(wr);
    readFirst.push(rf);
    control.push(whole - rc - wr - rf);
  }

  const results: ScenarioResult[] = [
    { name: 'tx total', timings: total },
    { name: 'tx read (count)', timings: readCount },
    { name: 'tx write (create)', timings: write },
    { name: 'tx read (findFirst)', timings: readFirst },
    { name: 'tx control (begin+commit)', timings: control },
  ];
  return results;
};
