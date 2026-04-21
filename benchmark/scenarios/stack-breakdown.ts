/**
 * Stack-breakdown benchmark — attributes peak RSS to specific stages of
 * the query stack (`pg.send` → `firstRow` → `resultBuilt` → …).
 *
 * Runs the same large-JSON read pattern against each adapter with
 * `stackProbe` armed so the runner can aggregate which stage drove the
 * peak most often. The primary tool for answering "where does the
 * bridge's memory overhead actually come from?" Requires `--expose-gc`.
 */
import { performance } from 'node:perf_hooks';
import type { Pool } from 'pg';
import type { MemoryDelta, MemorySnapshot, Scenario, StackAttribution } from '../adapters/types.ts';

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

const makeLargeJson = (run: number) => ({
  mode: 'stack-breakdown-heavy',
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

const SQL = `
  SELECT id, name, slug, config, labels, "createdAt"
  FROM "Tenant"
  WHERE id = $1
`;

type Probe = {
  run: <T>(label: string, adapter: string, fn: () => Promise<T>) => Promise<T>;
  take: (label: string) => StackAttribution | null;
  mark: (
    label: string,
    stage: string,
    meta?: Record<string, number | string | boolean | null>,
  ) => void;
};

type PendingTrace = {
  label: string;
  sampledPeak: {
    tMs: number;
    snapshot: MemorySnapshot;
  };
};

type Operation = {
  name: string;
  label: string;
  execute: (tenantId: string | number) => Promise<unknown>;
};

const repeated = (
  name: string,
  label: string,
  executeOnce: (tenantId: string | number) => Promise<unknown>,
): Operation => ({
  name: `${name} ×${REPEATED_READ_COUNT}`,
  label: `${label}-x${REPEATED_READ_COUNT}`,
  execute: async (tenantId) => {
    for (let i = 0; i < REPEATED_READ_COUNT; i++) {
      await executeOnce(tenantId);
    }
  },
});

const sqlLiteral = (value: string | number) =>
  typeof value === 'number' ? String(value) : `'${value.replaceAll("'", "''")}'`;

const runSampledQuery = async (
  label: string,
  execute: () => Promise<unknown>,
  stackProbe: Probe | undefined,
  adapterName: string | undefined,
): Promise<PendingTrace | null> => {
  if (!stackProbe || !adapterName) {
    await execute();
    return null;
  }

  const startedAt = performance.now();
  let peak = snapshot(`${label}:sampled.peak`);
  let peakAtMs = 0;
  let running = true;

  const sampler = (async () => {
    while (running) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const current = process.memoryUsage();
      if (current.rss >= peak.rss) {
        peak = {
          label: `${label}:sampled.peak`,
          rss: current.rss,
          heapUsed: current.heapUsed,
          arrayBuffers: current.arrayBuffers,
        };
        peakAtMs = performance.now() - startedAt;
      }
    }
  })();

  try {
    await stackProbe.run(label, adapterName, execute);
  } finally {
    running = false;
    await sampler;
  }

  return {
    label,
    sampledPeak: {
      tMs: peakAtMs,
      snapshot: peak,
    },
  };
};

export const stackBreakdown: Scenario = async (prisma, iterations) => {
  const stackProbe = (prisma as Record<string, unknown>).__stackProbe as Probe | undefined;
  const stackAdapterName = (prisma as Record<string, unknown>).__stackAdapterName as
    | string
    | undefined;
  const driverAdapter = (prisma as Record<string, unknown>).__driverAdapter as
    | {
        queryRaw: (query: {
          sql: string;
          args: unknown[];
          argTypes: unknown[];
        }) => Promise<unknown>;
      }
    | undefined;
  const pool = (prisma as Record<string, unknown>).__pool as Pool | undefined;
  const pglite = (prisma as Record<string, unknown>).__pglite as
    | {
        query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; fields: unknown[] }>;
      }
    | undefined;

  const operations: Operation[] = [];

  if (pglite) {
    const rawPglite = {
      name: 'raw pglite.query 1MB JSON',
      label: 'raw-pglite',
      execute: (tenantId) => pglite.query(SQL, [tenantId]),
    };
    operations.push(rawPglite, repeated(rawPglite.name, rawPglite.label, rawPglite.execute));
  }

  if (pool) {
    const pgPoolObject = {
      name: 'pg pool.query object rows 1MB JSON',
      label: 'pg-pool-object',
      execute: (tenantId) => pool.query(SQL, [tenantId]),
    };
    const pgPoolArray = {
      name: 'pg pool.query array rows 1MB JSON',
      label: 'pg-pool-array',
      execute: (tenantId) => pool.query({ text: SQL, values: [tenantId], rowMode: 'array' }),
    };
    operations.push(
      pgPoolObject,
      repeated(pgPoolObject.name, pgPoolObject.label, pgPoolObject.execute),
      pgPoolArray,
      repeated(pgPoolArray.name, pgPoolArray.label, pgPoolArray.execute),
    );
  }

  if (driverAdapter) {
    const adapterQueryRaw = {
      name: 'driver adapter.queryRaw 1MB JSON',
      label: 'driver-adapter-query-raw',
      execute: (tenantId: string | number) =>
        driverAdapter.queryRaw({
          sql: `
            SELECT id, name, slug, config, labels, "createdAt"
            FROM "Tenant"
            WHERE id = ${sqlLiteral(tenantId)}
          `,
          args: [],
          argTypes: [],
        }),
    };
    operations.push(
      adapterQueryRaw,
      repeated(adapterQueryRaw.name, adapterQueryRaw.label, adapterQueryRaw.execute),
    );
  }

  const prismaQueryRaw = {
    name: 'prisma $queryRaw 1MB JSON',
    label: 'prisma-query-raw',
    execute: (tenantId) => prisma.$queryRawUnsafe(SQL, tenantId),
  };
  const prismaFindUnique = {
    name: 'prisma findUnique 1MB JSON',
    label: 'prisma-find-unique',
    execute: (tenantId) =>
      prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          config: true,
          labels: true,
          createdAt: true,
        },
      }),
  };
  operations.push(
    prismaQueryRaw,
    repeated(prismaQueryRaw.name, prismaQueryRaw.label, prismaQueryRaw.execute),
    prismaFindUnique,
    repeated(prismaFindUnique.name, prismaFindUnique.label, prismaFindUnique.execute),
  );

  const results = [];

  for (const operation of operations) {
    const timings: number[] = [];
    const memory: MemorySnapshot[] = [];
    const iterationRetainedDelta: MemoryDelta[] = [];
    const attribution: StackAttribution[] = [];

    for (let run = 0; run < iterations; run++) {
      await resetTenants(prisma);
      const tenant = await prisma.tenant.create({
        data: {
          name: `${operation.label}-${run}`,
          slug: `${operation.label}-${run}`,
          config: makeLargeJson(run),
          labels: ['alpha', 'beta'],
        },
      });

      await settleMemory();
      const before = snapshot(`${operation.label}:run${run + 1}:before`);
      const start = performance.now();
      const pendingTrace = await runSampledQuery(
        `${operation.label}:run${run + 1}`,
        () => operation.execute(tenant.id),
        stackProbe,
        stackAdapterName,
      );
      timings.push(performance.now() - start);
      await settleMemory();
      if (pendingTrace) {
        stackProbe?.mark(pendingTrace.label, 'scenario.after_settle');
      }
      const after = snapshot(`${operation.label}:run${run + 1}:after`);
      memory.push(before, after);
      const retained = delta(`${operation.label}:run${run + 1}:retained`, after, before);
      iterationRetainedDelta.push(retained);

      if (pendingTrace) {
        const trace = stackProbe?.take(pendingTrace.label);
        if (!trace) continue;
        trace.stages.push({
          stage: 'sampled.peak',
          tMs: pendingTrace.sampledPeak.tMs,
          snapshot: pendingTrace.sampledPeak.snapshot,
          meta: null,
        });
        trace.stages.sort((a, b) => a.tMs - b.tMs);
        if (pendingTrace.sampledPeak.snapshot.rss >= trace.peak.rss) {
          trace.peakStage = 'sampled.peak';
          trace.peak = pendingTrace.sampledPeak.snapshot;
        }
        attribution.push(trace);
        const startRss = trace.stages[0]?.snapshot.rss ?? trace.peak.rss;
        console.log(
          `      run ${run + 1}/${iterations} ${operation.label}: peak ${trace.peakStage} rss ${MB(trace.peak.rss - startRss)} | retained rss ${MB(retained.rss)}`,
        );
      }
    }

    results.push({
      name: operation.name,
      timings,
      memory,
      iterationRetainedDelta,
      attribution,
    });
  }

  return results;
};
