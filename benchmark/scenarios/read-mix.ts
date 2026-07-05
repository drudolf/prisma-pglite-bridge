/**
 * Multi-shape read benchmark — a realistic mix of distinct read query
 * shapes issued repeatedly against one warm dataset.
 *
 * `findmany-focused` hammers a single SQL shape, which maximally warms one
 * prepared-statement cache entry — the bridge's best case against native
 * Postgres. Real applications issue many shapes per request path: point
 * lookups, filtered lists, sorts, projections, joins, aggregates. This
 * scenario rotates ~9 distinct shapes through a *shared* statement cache
 * every iteration, so no single entry dominates and the parse/plan cost of
 * shape diversity is exercised the way production reads exercise it.
 *
 * Each shape is reported as its own operation so the per-shape spread is
 * visible rather than averaged into one number.
 *
 *   NODE_OPTIONS="--expose-gc" pnpm bench --scenario read-mix -n 500 -w 50
 */
import type { Scenario, ScenarioResult } from '../adapters/types.ts';

const JOB_COUNT = 300;
const STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED', 'DELETED'] as const;

const timeOp = async (fn: () => Promise<unknown>): Promise<number> => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

export const readMix: Scenario = async (prisma, iterations) => {
  // ── seed one varied dataset (not timed) ──
  const stamp = Date.now();
  const tenant = await prisma.tenant.create({ data: { name: 'T', slug: `t-${stamp}` } });
  const [wsA, wsB] = await Promise.all([
    prisma.workspace.create({
      data: { name: 'A', slug: 'a', tenantId: tenant.id, apiKey: `ka_${stamp}` },
    }),
    prisma.workspace.create({
      data: { name: 'B', slug: 'b', tenantId: tenant.id, apiKey: `kb_${stamp}` },
    }),
  ]);
  await prisma.job.createMany({
    data: Array.from({ length: JOB_COUNT }, (_, i) => ({
      friendlyId: `j_${i}_${stamp}`,
      workspaceId: i % 2 === 0 ? wsA.id : wsB.id,
      status: STATUSES[i % STATUSES.length],
      priority: i % 5,
      tags: i % 3 === 0 ? ['hot', `p${i % 5}`] : [],
    })),
  });
  const jobs = await prisma.job.findMany({ select: { id: true }, take: 120 });
  await prisma.attempt.createMany({
    data: jobs.flatMap((job, i) => [
      { jobId: job.id, number: 1, status: 'ACTIVE' as const },
      ...(i % 2 === 0 ? [{ jobId: job.id, number: 2, status: 'ARCHIVED' as const }] : []),
    ]),
  });

  const sampleId = jobs[Math.floor(jobs.length / 2)]?.id ?? '';
  const tenantSlug = tenant.slug;
  const wsId = wsA.id;

  if (typeof globalThis.gc === 'function') globalThis.gc();

  // ── distinct read shapes; each compiles to its own SQL statement ──
  const shapes: { name: string; run: () => Promise<unknown> }[] = [
    { name: 'point lookup', run: () => prisma.job.findUnique({ where: { id: sampleId } }) },
    {
      name: 'indexed where',
      run: () => prisma.job.findMany({ where: { status: 'ACTIVE' }, take: 50 }),
    },
    {
      name: 'filter + sort',
      run: () =>
        prisma.job.findMany({
          where: { priority: { gte: 2 } },
          orderBy: { createdAt: 'desc' },
          take: 25,
        }),
    },
    {
      name: 'select projection',
      run: () =>
        prisma.job.findMany({
          where: { workspaceId: wsId },
          select: { id: true, friendlyId: true, status: true, priority: true },
          take: 50,
        }),
    },
    {
      name: 'include workspace',
      run: () => prisma.job.findMany({ include: { workspace: true }, take: 30 }),
    },
    {
      name: 'deep include',
      run: () =>
        prisma.job.findMany({
          include: { workspace: { include: { tenant: true } }, attempts: true },
          take: 20,
        }),
    },
    { name: 'count', run: () => prisma.job.count({ where: { status: 'DRAFT' } }) },
    {
      name: 'groupBy status',
      run: () => prisma.job.groupBy({ by: ['status'], _count: { _all: true } }),
    },
    {
      name: 'nested filter',
      run: () =>
        prisma.job.findMany({ where: { workspace: { tenant: { slug: tenantSlug } } }, take: 15 }),
    },
  ];

  const timings = new Map<string, number[]>(shapes.map((shape) => [shape.name, []]));
  for (let i = 0; i < iterations; i++) {
    for (const shape of shapes) {
      timings.get(shape.name)?.push(await timeOp(shape.run));
    }
  }

  return shapes.map<ScenarioResult>((shape) => ({
    name: shape.name,
    timings: timings.get(shape.name) ?? [],
  }));
};
