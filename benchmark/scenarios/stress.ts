/**
 * Stress benchmark — contention, throughput, bridge-specific scenarios.
 *
 * Calibrated to test bridge overhead, not PGlite WASM throughput.
 * Each scenario runs once per iteration (the runner handles repeats).
 */
import type { PrismaClient } from '@prisma/client';
import type { Scenario, ScenarioResult } from '../adapters/types.ts';

const timeOp = async (fn: () => Promise<unknown>): Promise<number> => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

const ensureWorkspace = async (prisma: PrismaClient) => {
  const tenant = await prisma.tenant.upsert({
    where: { slug: 'stress' },
    create: { name: 'Stress', slug: 'stress' },
    update: {},
  });
  const ws = await prisma.workspace.upsert({
    where: { apiKey: 'stress-key' },
    create: { name: 'WS', slug: 'ws', tenantId: tenant.id, apiKey: 'stress-key' },
    update: {},
  });
  return { tenant, ws };
};

export const stress: Scenario = async (prisma, iterations) => {
  const results: ScenarioResult[] = [];
  const { ws } = await ensureWorkspace(prisma);

  // ── 200 sequential single creates ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const perOp: number[] = [];
      for (let i = 0; i < 200; i++) {
        const ms = await timeOp(() =>
          prisma.job.create({
            data: { friendlyId: `seq_${iter}_${i}_${Date.now()}`, workspaceId: ws.id },
          }),
        );
        perOp.push(ms);
      }
      timings.push(perOp.reduce((a, b) => a + b, 0));
    }
    results.push({ name: '200 seq creates (total)', timings, ops: 200 });
  }

  // ── 200-row createMany ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const ms = await timeOp(() =>
        prisma.job.createMany({
          data: Array.from({ length: 200 }, (_, i) => ({
            friendlyId: `cm_${iter}_${i}_${Date.now()}`,
            workspaceId: ws.id,
            priority: i % 5,
          })),
        }),
      );
      timings.push(ms);
    }
    results.push({ name: '200 createMany', timings });
  }

  // ── findMany 500 rows ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const ms = await timeOp(() =>
        prisma.job.findMany({ where: { workspaceId: ws.id }, take: 500 }),
      );
      timings.push(ms);
    }
    results.push({ name: 'findMany 500', timings });
  }

  // ── 30 nested creates (3-level) ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const ms = await timeOp(async () => {
        for (let i = 0; i < 30; i++) {
          await prisma.catalogEntry.create({
            data: {
              friendlyId: `nc_${iter}_${i}_${Date.now()}`,
              name: `model-${i}`,
              pattern: `^model-${i}$`,
              provider: 'openai',
              tiers: {
                create: {
                  name: 'Default',
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
          });
        }
      });
      timings.push(ms);
    }
    results.push({ name: '30 nested creates', timings, ops: 30 });
  }

  // ── 50 concurrent findMany (runExclusive contention) ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const ms = await timeOp(() =>
        Promise.all(
          Array.from({ length: 50 }, () =>
            prisma.job.findMany({ where: { workspaceId: ws.id }, take: 10 }),
          ),
        ),
      );
      timings.push(ms);
    }
    results.push({ name: '50 concurrent reads', timings, ops: 50 });
  }

  // ── 10 concurrent interactive transactions ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const ms = await timeOp(() =>
        Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            prisma.$transaction(async (tx) => {
              const count = await tx.job.count();
              await tx.batch.create({
                data: {
                  friendlyId: `ctx_${iter}_${i}_${Date.now()}`,
                  metadata: { count },
                },
              });
              return tx.batch.findFirst({ orderBy: { createdAt: 'desc' } });
            }),
          ),
        ),
      );
      timings.push(ms);
    }
    results.push({ name: '10 concurrent txns', timings, ops: 10 });
  }

  // ── mixed read/write contention ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const ms = await timeOp(() => {
        const write = prisma.job.createMany({
          data: Array.from({ length: 200 }, (_, i) => ({
            friendlyId: `mix_${iter}_${i}_${Date.now()}`,
            workspaceId: ws.id,
          })),
        });
        const reads = Array.from({ length: 20 }, () =>
          prisma.job.findMany({ where: { workspaceId: ws.id }, take: 10 }),
        );
        return Promise.all([write, ...reads]);
      });
      timings.push(ms);
    }
    results.push({ name: 'mixed read/write', timings });
  }

  // ── read-after-write consistency ──
  {
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const tag = `raw_${iter}_${Date.now()}`;
      const ms = await timeOp(async () => {
        await prisma.job.createMany({
          data: Array.from({ length: 500 }, (_, i) => ({
            friendlyId: `${tag}_${i}`,
            workspaceId: ws.id,
            tags: [tag],
          })),
        });
        const count = await prisma.job.count({ where: { tags: { has: tag } } });
        if (count !== 500) throw new Error(`Consistency failure: expected 500, got ${count}`);
      });
      timings.push(ms);
    }
    results.push({ name: 'read-after-write 500', timings });
  }

  // ── 1MB JSON payload ──
  {
    const bigJson = { data: 'x'.repeat(1_000_000), nested: { deep: true } };
    const timings: number[] = [];
    for (let iter = 0; iter < iterations; iter++) {
      const ms = await timeOp(async () => {
        const tenant = await prisma.tenant.create({
          data: { name: `json-${iter}`, slug: `json-${iter}-${Date.now()}`, config: bigJson },
        });
        await prisma.tenant.findUnique({ where: { id: tenant.id } });
      });
      timings.push(ms);
    }
    results.push({ name: '1MB JSON round-trip', timings });
  }

  return results;
};
