/**
 * Micro benchmark — latency of common Prisma operations.
 *
 * Covers single/bulk create, findMany, nested create, deep include,
 * interactive transaction, and update+find. Timing only (no memory
 * tracking). The default scenario for quick adapter comparisons.
 */
import type { Scenario, ScenarioResult } from '../adapters/types.ts';

const timeOp = async (fn: () => Promise<unknown>): Promise<number> => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

export const micro: Scenario = async (prisma, iterations) => {
  const results: ScenarioResult[] = [];

  // ── single create ──
  {
    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const ms = await timeOp(() =>
        prisma.tenant.create({ data: { name: `T${i}`, slug: `t-${i}-${Date.now()}` } }),
      );
      timings.push(ms);
    }
    results.push({ name: 'single create', timings });
  }

  // ── 100 createMany ──
  {
    const tenant = await prisma.tenant.create({
      data: { name: 'Bulk', slug: `bulk-${Date.now()}` },
    });
    const ws = await prisma.workspace.create({
      data: { name: 'WS', slug: 'ws', tenantId: tenant.id, apiKey: `k_${Date.now()}` },
    });
    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const ms = await timeOp(() =>
        prisma.job.createMany({
          data: Array.from({ length: 100 }, (_, j) => ({
            friendlyId: `cm_${i}_${j}_${Date.now()}`,
            workspaceId: ws.id,
            priority: j % 5,
          })),
        }),
      );
      timings.push(ms);
    }
    results.push({ name: '100 createMany', timings });
  }

  // ── findMany 100 rows ──
  {
    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const ms = await timeOp(() => prisma.job.findMany({ take: 100 }));
      timings.push(ms);
    }
    results.push({ name: 'findMany 100', timings });
  }

  // ── nested create (3-level) ──
  {
    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const ms = await timeOp(() =>
        prisma.catalogEntry.create({
          data: {
            friendlyId: `nc_${i}_${Date.now()}`,
            name: 'gpt-4o',
            pattern: '^gpt-4o$',
            provider: 'openai',
            capabilities: ['chat', 'vision'],
            tiers: {
              create: {
                name: 'Standard',
                isDefault: true,
                prices: {
                  create: [
                    { kind: 'input', amount: '0.000005' },
                    { kind: 'output', amount: '0.000015' },
                  ],
                },
              },
            },
          },
          include: { tiers: { include: { prices: true } } },
        }),
      );
      timings.push(ms);
    }
    results.push({ name: 'nested create', timings });
  }

  // ── deep include ──
  {
    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const ms = await timeOp(() =>
        prisma.job.findMany({
          include: { workspace: { include: { tenant: true } }, attempts: true },
          take: 50,
        }),
      );
      timings.push(ms);
    }
    results.push({ name: 'deep include', timings });
  }

  // ── interactive transaction (read → conditional write → commit) ──
  {
    const timings: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const ms = await timeOp(() =>
        prisma.$transaction(async (tx) => {
          const count = await tx.job.count();
          await tx.batch.create({
            data: { friendlyId: `tx_${i}_${Date.now()}`, metadata: { jobCount: count } },
          });
          await tx.batch.findFirst({ orderBy: { createdAt: 'desc' } });
        }),
      );
      timings.push(ms);
    }
    results.push({ name: 'interactive tx', timings });
  }

  // ── update + findUnique ──
  {
    const jobs = await prisma.job.findMany({ take: iterations });
    const timings: number[] = [];
    for (let i = 0; i < Math.min(iterations, jobs.length); i++) {
      const job = jobs[i];
      if (!job) continue;
      const ms = await timeOp(async () => {
        await prisma.job.update({
          where: { id: job.id },
          data: { status: 'ACTIVE', startedAt: new Date() },
        });
        await prisma.job.findUnique({ where: { id: job.id } });
      });
      timings.push(ms);
    }
    results.push({ name: 'update + find', timings });
  }

  return results;
};
