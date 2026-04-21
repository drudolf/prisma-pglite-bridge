/**
 * Focused findMany 100 benchmark — isolates the read-path hot spot from
 * the aggregate `micro` suite so tail-latency regressions are detectable
 * without being drowned in setup and cross-operation noise.
 *
 * Intended invocation (from the package root):
 *   NODE_OPTIONS="--expose-gc" pnpm bench --scenario findmany-focused -n 1000 -w 100
 *
 * For cross-revision comparisons, check the other revision into a git
 * worktree, run the same command in both trees back-to-back, and diff
 * the reported p50/p95/p99.
 */
import type { Scenario } from '../adapters/types.ts';

const ROW_COUNT = 200;
const TAKE = 100;

export const findManyFocused: Scenario = async (prisma, iterations) => {
  const tenant = await prisma.tenant.create({
    data: { name: 'T', slug: `t-${Date.now()}` },
  });
  const ws = await prisma.workspace.create({
    data: {
      name: 'W',
      slug: 'w',
      tenantId: tenant.id,
      apiKey: `k_${Date.now()}`,
    },
  });
  await prisma.job.createMany({
    data: Array.from({ length: ROW_COUNT }, (_, i) => ({
      friendlyId: `j_${i}_${Date.now()}`,
      workspaceId: ws.id,
      priority: i % 5,
    })),
  });

  if (typeof globalThis.gc === 'function') globalThis.gc();

  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await prisma.job.findMany({ take: TAKE });
    timings.push(performance.now() - start);
  }

  return [{ name: `findMany ${TAKE}`, timings }];
};
