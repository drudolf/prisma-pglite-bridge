/**
 * Path-split memory benchmark — isolates direct PGlite, driver-adapter,
 * Prisma, and maintenance overhead instead of mixing them into one run.
 *
 * Use this when a memory regression shows up in the aggregate `memory`
 * scenario and you need to answer which layer is actually retaining bytes.
 */
import { performance } from 'node:perf_hooks';
import type { DriverAdapter } from '@prisma/driver-adapter-utils';
import type { Pool } from 'pg';
import type { MemoryDelta, MemorySnapshot, Scenario, ScenarioResult } from '../adapters/types.ts';

const gc = () => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
};

const settleMemory = async () => {
  gc();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  gc();
};

const snapshot = (label: string): MemorySnapshot => {
  const m = process.memoryUsage();
  return {
    label,
    rss: m.rss,
    heapUsed: m.heapUsed,
    arrayBuffers: m.arrayBuffers,
  };
};

const delta = (label: string, after: MemorySnapshot, before: MemorySnapshot): MemoryDelta => ({
  label,
  rss: after.rss - before.rss,
  heapUsed: after.heapUsed - before.heapUsed,
  arrayBuffers: after.arrayBuffers - before.arrayBuffers,
});

const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
const ONE_MB = 1024 * 1024;
const REPEATED_READ_COUNT = 20;

const SQL = `
  SELECT id, name, slug, config, labels, "createdAt"
  FROM "Tenant"
  WHERE id = $1
`;

const makeLargeJson = (run: number) => ({
  mode: 'path-split-heavy',
  run,
  ok: true,
  blob: 'x'.repeat(ONE_MB),
  meta: {
    tags: ['alpha', 'beta', 'gamma'],
    nested: { level: 1, enabled: true },
  },
});

const resetTenants = async (prisma: typeof import('@prisma/client').PrismaClient) => {
  await prisma.tenant.deleteMany();
  await settleMemory();
};

type PGliteLike = {
  query: <T>(
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; fields?: Array<{ name: string; dataTypeID: number }> }>;
  exec: (sql: string) => Promise<void>;
};

type DriverAdapterLike = Pick<DriverAdapter, 'queryRaw'>;

type Operation = {
  name: string;
  execute: (tenantId: string) => Promise<void>;
};

const samplePeakWhile = async (label: string, execute: () => Promise<void>) => {
  await settleMemory();
  const before = snapshot(`${label}:before`);
  const peak = { ...before, label: `${label}:peak` };
  let running = true;

  const sampler = (async () => {
    while (running) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const current = process.memoryUsage();
      if (current.rss > peak.rss) peak.rss = current.rss;
      if (current.heapUsed > peak.heapUsed) peak.heapUsed = current.heapUsed;
      if (current.arrayBuffers > peak.arrayBuffers) peak.arrayBuffers = current.arrayBuffers;
    }
  })();

  try {
    await execute();
  } finally {
    running = false;
    await sampler;
  }

  await settleMemory();
  const after = snapshot(`${label}:after`);
  return { before, peak, after };
};

export const pathSplit: Scenario = async (prisma, iterations) => {
  const pglite = (prisma as Record<string, unknown>).__pglite as PGliteLike | undefined;
  const pool = (prisma as Record<string, unknown>).__pool as Pool | undefined;
  const driverAdapter = (prisma as Record<string, unknown>).__driverAdapter as
    | DriverAdapterLike
    | undefined;

  const operations: Operation[] = [];

  if (pglite) {
    operations.push({
      name: 'raw pglite.query ×20',
      execute: async (tenantId) => {
        for (let i = 0; i < REPEATED_READ_COUNT; i++) {
          await pglite.query(SQL, [tenantId]);
        }
      },
    });
  }

  if (driverAdapter) {
    operations.push({
      name: 'driver adapter.queryRaw ×20',
      execute: async (tenantId) => {
        for (let i = 0; i < REPEATED_READ_COUNT; i++) {
          await driverAdapter.queryRaw({
            sql: `
              SELECT id, name, slug, config, labels, "createdAt"
              FROM "Tenant"
              WHERE id = '${tenantId.replaceAll("'", "''")}'
            `,
            args: [],
            argTypes: [],
          });
        }
      },
    });
  }

  if (pool) {
    operations.push({
      name: 'bridge pool.query array ×20',
      execute: async (tenantId) => {
        for (let i = 0; i < REPEATED_READ_COUNT; i++) {
          await pool.query({ text: SQL, values: [tenantId], rowMode: 'array' });
        }
      },
    });
  }

  operations.push({
    name: 'prisma findUnique ×20',
    execute: async (tenantId) => {
      for (let i = 0; i < REPEATED_READ_COUNT; i++) {
        await prisma.tenant.findUnique({
          where: { id: tenantId },
          select: {
            id: true,
            name: true,
            slug: true,
            config: true,
            labels: true,
            createdAt: true,
          },
        });
      }
    },
  });

  if (pglite) {
    operations.push({
      name: 'direct maintenance cycle',
      execute: async () => {
        const { rows } = await pglite.query<{ tablename: string }>(
          `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
        );
        if (rows.length === 0) return;
        await pglite.exec('SET session_replication_role = replica');
        for (const row of rows) {
          await pglite.exec(`TRUNCATE TABLE "${row.tablename}" CASCADE`);
        }
        await pglite.exec('SET session_replication_role = DEFAULT');
      },
    });
  }

  const results: ScenarioResult[] = [];

  for (const operation of operations) {
    const timings: number[] = [];
    const memory: MemorySnapshot[] = [];
    const iterationRetainedDelta: MemoryDelta[] = [];

    for (let run = 0; run < iterations; run++) {
      await resetTenants(prisma);
      const tenant = await prisma.tenant.create({
        data: {
          name: `path-split-${operation.name}-${run}`,
          slug: `path-split-${run}-${operation.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
          config: makeLargeJson(run),
          labels: ['alpha', 'beta'],
        },
      });

      const startedAt = performance.now();
      const sampled = await samplePeakWhile(
        `run${run + 1}:${operation.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-')}`,
        () => operation.execute(tenant.id),
      );
      timings.push(performance.now() - startedAt);
      memory.push(sampled.before, sampled.peak, sampled.after);
      iterationRetainedDelta.push(
        delta(`run${run + 1}:${operation.name}:retained`, sampled.after, sampled.before),
      );

      console.log(
        `      run ${run + 1}/${iterations} ${operation.name}: peak rss Δ${MB(sampled.peak.rss - sampled.before.rss)}, retained rss Δ${MB(sampled.after.rss - sampled.before.rss)}`,
      );
    }

    results.push({
      name: operation.name,
      timings,
      memory,
      iterationRetainedDelta,
    });
  }

  return results;
};
