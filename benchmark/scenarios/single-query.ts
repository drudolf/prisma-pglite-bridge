/**
 * Single-query benchmark — measures a single large-result query in
 * isolation to expose per-query allocation patterns.
 *
 * Forces GC between steps, snapshots RSS/heap/arrayBuffers before and
 * after, and emits a {@link StackAttribution} trace if the adapter's
 * stack probe is armed. Useful for catching regressions in per-query
 * memory overhead that micro benchmarks average away. Requires
 * `--expose-gc`.
 */
import { performance } from 'node:perf_hooks';
import type {
  MemoryDelta,
  MemorySnapshot,
  Scenario,
  StackAttribution,
  StackAttributionStage,
} from '../adapters/types.ts';

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

const makeLargeJson = (run: number) => ({
  mode: 'single-query-heavy',
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

const runSampledStackQuery = async (
  label: string,
  execute: () => Promise<unknown>,
  stackProbe:
    | {
        run: <T>(label: string, adapter: string, fn: () => Promise<T>) => Promise<T>;
        take: (label: string) => StackAttribution | null;
      }
    | undefined,
  adapterName: string | undefined,
): Promise<StackAttribution | null> => {
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

  const trace = stackProbe.take(label);
  if (!trace) return null;

  const sampledPeakStage: StackAttributionStage = {
    stage: 'sampled.peak',
    tMs: peakAtMs,
    snapshot: peak,
    meta: null,
  };
  trace.stages.push(sampledPeakStage);
  trace.stages.sort((a, b) => a.tMs - b.tMs);
  if (sampledPeakStage.snapshot.rss >= trace.peak.rss) {
    trace.peakStage = sampledPeakStage.stage;
    trace.peak = sampledPeakStage.snapshot;
  }
  return trace;
};

export const singleQuery: Scenario = async (prisma, iterations) => {
  const timings: number[] = [];
  const memory: MemorySnapshot[] = [];
  const iterationRetainedDelta: MemoryDelta[] = [];
  const attribution: StackAttribution[] = [];

  const stackProbe = (prisma as Record<string, unknown>).__stackProbe as
    | {
        run: <T>(label: string, adapter: string, fn: () => Promise<T>) => Promise<T>;
        take: (label: string) => StackAttribution | null;
      }
    | undefined;
  const stackAdapterName = (prisma as Record<string, unknown>).__stackAdapterName as
    | string
    | undefined;

  for (let run = 0; run < iterations; run++) {
    await resetTenants(prisma);
    const tenant = await prisma.tenant.create({
      data: {
        name: `single-query-${run}`,
        slug: `single-query-${run}`,
        config: makeLargeJson(run),
        labels: ['alpha', 'beta'],
      },
    });

    await settleMemory();
    const before = snapshot(`run${run + 1}:before`);
    const start = performance.now();
    const trace = await runSampledStackQuery(
      `run${run + 1}:single-findUnique`,
      () =>
        prisma.tenant.findUnique({
          where: { id: tenant.id },
          select: {
            id: true,
            name: true,
            slug: true,
            config: true,
            labels: true,
            createdAt: true,
          },
        }),
      stackProbe,
      stackAdapterName,
    );
    timings.push(performance.now() - start);
    await settleMemory();
    const after = snapshot(`run${run + 1}:after`);
    memory.push(before, after);
    const retained = delta(`run${run + 1}:retained`, after, before);
    iterationRetainedDelta.push(retained);

    if (trace) {
      attribution.push(trace);
      const startRss = trace.stages[0]?.snapshot.rss ?? trace.peak.rss;
      console.log(
        `      run ${run + 1}/${iterations} single query 1MB json: peak ${trace.peakStage} rss ${MB(trace.peak.rss - startRss)} | retained rss ${MB(retained.rss)}`,
      );
    }
  }

  return [
    {
      name: 'single findUnique 1MB JSON',
      timings,
      memory,
      iterationRetainedDelta,
      attribution,
    },
  ];
};
