#!/usr/bin/env tsx
/**
 * Benchmark harness for prisma-pglite-bridge vs pglite-prisma-adapter.
 *
 * Usage:
 *   pnpm bench                                           # all adapters, micro
 *   pnpm bench --adapter prisma-pglite-bridge            # single adapter
 *   pnpm bench --scenario stress                         # single scenario
 *   pnpm bench --adapter pglite-prisma-adapter --scenario stress -n 3
 *   pnpm bench --json                                    # structured JSON to stdout
 *   pnpm bench --scenario all                            # all scenarios
 */
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type {
  AdapterContext,
  AdapterHarness,
  Attribution,
  Scenario,
  ScenarioResult,
  StackAttribution,
} from './adapters/types.ts';
import { loadBenchEnv } from './env.ts';

loadBenchEnv();

// ─── Schema SQL generation ───

const generateSchemaSql = (): string => {
  const binDir = join(import.meta.dirname, '..', 'node_modules', '.bin');
  process.env.PATH = `${binDir}:${process.env.PATH}`;
  return execSync('prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script', {
    encoding: 'utf8',
    timeout: 30_000,
    cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, DATABASE_URL: 'postgresql://dummy@localhost/dummy' },
  });
};

// ─── Stats ───

const sorted = (arr: number[]) => [...arr].sort((a, b) => a - b);
const percentile = (arr: number[], p: number) => {
  const s = sorted(arr);
  const idx = Math.ceil((p / 100) * s.length) - 1;
  return s[Math.max(0, idx)] ?? 0;
};
const median = (arr: number[]) => percentile(arr, 50);
const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
const stddev = (arr: number[]) => {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + (v - m) ** 2, 0) / arr.length);
};
const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`);

// ─── CLI args ───

const args = process.argv.slice(2);
const getArg = (name: string, shortName?: string): string | undefined => {
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0) return args[idx + 1];
  if (shortName) {
    const shortIdx = args.indexOf(`-${shortName}`);
    if (shortIdx >= 0) return args[shortIdx + 1];
  }
  return undefined;
};
const hasFlag = (name: string) => args.includes(`--${name}`);

const adapterFilter = getArg('adapter');
const scenarioFilter = getArg('scenario') ?? 'micro';
const iterations = Number(getArg('n', 'n') ?? '5');
const repeat = Number(getArg('repeat', 'r') ?? '1');
const jsonOutput = hasFlag('json');

// ─── Load adapters ───

const loadAdapters = async (): Promise<AdapterHarness[]> => {
  const all: AdapterHarness[] = [];

  if (
    !adapterFilter ||
    adapterFilter === 'prisma-pglite-bridge' ||
    adapterFilter === 'bridge' ||
    adapterFilter === 'enlite'
  ) {
    const { bridge } = await import('./adapters/bridge.ts');
    all.push(bridge);
  }
  if (!adapterFilter || adapterFilter === 'pglite-prisma-adapter') {
    const { pglitePrismaAdapter } = await import('./adapters/pglite-prisma-adapter.ts');
    all.push(pglitePrismaAdapter);
  }
  if (!adapterFilter || adapterFilter === 'postgres-pg' || adapterFilter === 'postgres') {
    const { postgresPg } = await import('./adapters/postgres-pg.ts');
    all.push(postgresPg);
  }

  return all;
};

// ─── Load scenarios ───

const loadScenarios = async (): Promise<[string, Scenario][]> => {
  const all: [string, Scenario][] = [];

  if (scenarioFilter === 'all' || scenarioFilter === 'micro') {
    const { micro } = await import('./scenarios/micro.ts');
    all.push(['micro', micro]);
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'stress') {
    const { stress } = await import('./scenarios/stress.ts');
    all.push(['stress', stress]);
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'memory') {
    const { memory } = await import('./scenarios/memory.ts');
    all.push(['memory', memory]);
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'single-query') {
    const { singleQuery } = await import('./scenarios/single-query.ts');
    all.push(['single-query', singleQuery]);
  }
  if (scenarioFilter === 'all' || scenarioFilter === 'stack-breakdown') {
    const { stackBreakdown } = await import('./scenarios/stack-breakdown.ts');
    all.push(['stack-breakdown', stackBreakdown]);
  }

  return all;
};

// ─── Memory ───

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

interface MemSnapshot {
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

interface ServerSnapshot {
  rss: number;
}

const snap = (): MemSnapshot => {
  gc();
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers };
};

const snapServer = async (ctx: AdapterContext | null | undefined): Promise<ServerSnapshot> => {
  const sampler = ctx?.serverProcessSampler;
  if (!sampler) return { rss: 0 };

  const pids = [
    ...new Set((await sampler.listPids()).filter((pid) => Number.isInteger(pid) && pid > 0)),
  ];
  if (pids.length === 0) return { rss: 0 };

  try {
    const output = execSync(`ps -o pid=,rss= -p ${pids.join(',')}`, {
      encoding: 'utf8',
      timeout: 5_000,
    });

    let rssKb = 0;
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [, rss] = trimmed.split(/\s+/);
      const parsed = Number(rss);
      if (Number.isFinite(parsed)) rssKb += parsed;
    }
    return { rss: rssKb * 1024 };
  } catch {
    return { rss: 0 };
  }
};

const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

interface MemDelta {
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

interface ServerDelta {
  rss: number;
}

interface NumberSummary {
  median: number;
  min: number;
  max: number;
  mean: number;
  stddev: number;
}

const diffMem = (to: MemSnapshot, from: MemSnapshot): MemDelta => ({
  rss: to.rss - from.rss,
  heapUsed: to.heapUsed - from.heapUsed,
  arrayBuffers: to.arrayBuffers - from.arrayBuffers,
});

const diffServer = (to: ServerSnapshot, from: ServerSnapshot): ServerDelta => ({
  rss: to.rss - from.rss,
});

const summarizeNumbers = (values: number[]): NumberSummary => ({
  median: median(values),
  min: Math.min(...values),
  max: Math.max(...values),
  mean: mean(values),
  stddev: stddev(values),
});

const summarizeMemDelta = (values: MemDelta[]) => ({
  rss: summarizeNumbers(values.map((value) => value.rss)),
  heapUsed: summarizeNumbers(values.map((value) => value.heapUsed)),
  arrayBuffers: summarizeNumbers(values.map((value) => value.arrayBuffers)),
});

// ─── Runner ───

interface RunResult {
  repeatIndex: number;
  adapter: string;
  scenario: string;
  results: ScenarioResult[];
  setupTime: number;
  teardownTime: number;
  memBefore: MemSnapshot;
  memPeak: MemSnapshot;
  memAfter: MemSnapshot;
  serverBefore: ServerSnapshot;
  serverPeak: ServerSnapshot;
  serverAfter: ServerSnapshot;
  error?: string;
}

const runAdapterScenario = async (
  harness: AdapterHarness,
  scenarioName: string,
  scenario: Scenario,
  schemaSql: string,
): Promise<RunResult> => {
  try {
    // Setup (timed)
    const setupStart = performance.now();
    const ctx = await harness.setup(schemaSql);
    const setupTime = performance.now() - setupStart;

    // Warmup iteration (discarded)
    try {
      await scenario(ctx.prisma, 1);
      await harness.truncate(ctx);
    } catch {
      // Warmup failure is non-fatal — truncate might fail if scenario errored
    }

    await settleMemory();
    const memBefore = snap();
    const serverBefore = await snapServer(ctx);

    // Real run
    const scenarioResults = await scenario(ctx.prisma, iterations);

    await settleMemory();
    const memPeak = snap();
    const serverPeak = await snapServer(ctx);

    // Teardown (timed)
    const teardownStart = performance.now();
    await harness.teardown(ctx);
    const teardownTime = performance.now() - teardownStart;

    await settleMemory();
    const memAfter = snap();
    const serverAfter = await snapServer(ctx);

    return {
      repeatIndex: 1,
      adapter: harness.name,
      scenario: scenarioName,
      results: scenarioResults,
      setupTime,
      teardownTime,
      memBefore,
      memPeak,
      memAfter,
      serverBefore,
      serverPeak,
      serverAfter,
    };
  } catch (err) {
    const m = snap();
    return {
      repeatIndex: 1,
      adapter: harness.name,
      scenario: scenarioName,
      results: [],
      setupTime: 0,
      teardownTime: 0,
      memBefore: m,
      memPeak: m,
      memAfter: m,
      serverBefore: { rss: 0 },
      serverPeak: { rss: 0 },
      serverAfter: { rss: 0 },
      error: (err as Error).message,
    };
  }
};

interface AggregatedOperation {
  name: string;
  repeats: number;
  p50: NumberSummary;
  p95: NumberSummary;
  p99: NumberSummary;
  min: NumberSummary;
  max: NumberSummary;
  mean: NumberSummary;
  stddev: NumberSummary;
  ops: NumberSummary | null;
  iterationRetainedDelta: {
    rss: NumberSummary;
    heapUsed: NumberSummary;
    arrayBuffers: NumberSummary;
  } | null;
  stackAttribution: AggregatedStackAttribution | null;
}

interface AggregatedMemorySlice {
  repeats: number;
  setupTime: NumberSummary;
  teardownTime: NumberSummary;
  baseline: {
    clientRss: NumberSummary;
    serverRss: NumberSummary;
    combinedRss: NumberSummary;
  };
  peakDelta: {
    rss: NumberSummary;
    heapUsed: NumberSummary;
    arrayBuffers: NumberSummary;
  };
  serverPeakDelta: {
    rss: NumberSummary;
  };
  combinedPeakDelta: {
    rss: NumberSummary;
  };
  retainedDelta: {
    rss: NumberSummary;
    heapUsed: NumberSummary;
    arrayBuffers: NumberSummary;
  };
  serverRetainedDelta: {
    rss: NumberSummary;
  };
  combinedRetainedDelta: {
    rss: NumberSummary;
  };
}

interface AggregatedStackStage {
  stage: string;
  hits: number;
  tMs: NumberSummary;
  rssDelta: NumberSummary;
  heapDelta: NumberSummary;
  arrayBuffersDelta: NumberSummary;
}

interface AggregatedStackAttribution {
  traces: number;
  peakStageCounts: Record<string, number>;
  peakRssDelta: NumberSummary;
  stages: AggregatedStackStage[];
}

const isStackAttribution = (attribution: Attribution): attribution is StackAttribution =>
  'peakStage' in attribution && 'stages' in attribution;

const summarizeStackAttribution = (
  attributions: StackAttribution[],
): AggregatedStackAttribution | null => {
  if (attributions.length === 0) return null;

  const peakStageCounts: Record<string, number> = {};
  const peakRssDeltas: number[] = [];
  const stageGroups = new Map<
    string,
    Array<{ tMs: number; rssDelta: number; heapDelta: number; arrayBuffersDelta: number }>
  >();

  for (const attribution of attributions) {
    const firstStage = attribution.stages[0];
    if (!firstStage) continue;

    peakStageCounts[attribution.peakStage] = (peakStageCounts[attribution.peakStage] ?? 0) + 1;
    peakRssDeltas.push(attribution.peak.rss - firstStage.snapshot.rss);

    for (const stage of attribution.stages) {
      const bucket = stageGroups.get(stage.stage) ?? [];
      bucket.push({
        tMs: stage.tMs,
        rssDelta: stage.snapshot.rss - firstStage.snapshot.rss,
        heapDelta: stage.snapshot.heapUsed - firstStage.snapshot.heapUsed,
        arrayBuffersDelta: stage.snapshot.arrayBuffers - firstStage.snapshot.arrayBuffers,
      });
      stageGroups.set(stage.stage, bucket);
    }
  }

  const stages = Array.from(stageGroups.entries())
    .map<AggregatedStackStage>(([stage, values]) => ({
      stage,
      hits: values.length,
      tMs: summarizeNumbers(values.map((value) => value.tMs)),
      rssDelta: summarizeNumbers(values.map((value) => value.rssDelta)),
      heapDelta: summarizeNumbers(values.map((value) => value.heapDelta)),
      arrayBuffersDelta: summarizeNumbers(values.map((value) => value.arrayBuffersDelta)),
    }))
    .sort((a, b) => a.tMs.median - b.tMs.median);

  return {
    traces: attributions.length,
    peakStageCounts,
    peakRssDelta: summarizeNumbers(peakRssDeltas),
    stages,
  };
};

interface AggregatedRunResult {
  adapter: string;
  scenario: string;
  repeats: number;
  setupTime: NumberSummary;
  teardownTime: NumberSummary;
  baseline: {
    clientRss: NumberSummary;
    serverRss: NumberSummary;
    combinedRss: NumberSummary;
  };
  peakDelta: {
    rss: NumberSummary;
    heapUsed: NumberSummary;
    arrayBuffers: NumberSummary;
  };
  serverPeakDelta: {
    rss: NumberSummary;
  };
  combinedPeakDelta: {
    rss: NumberSummary;
  };
  retainedDelta: {
    rss: NumberSummary;
    heapUsed: NumberSummary;
    arrayBuffers: NumberSummary;
  };
  serverRetainedDelta: {
    rss: NumberSummary;
  };
  combinedRetainedDelta: {
    rss: NumberSummary;
  };
  errors: string[];
  runs: RunResult[];
  operations: AggregatedOperation[];
  repeatSlices: {
    firstRepeat: AggregatedMemorySlice | null;
    warmedRepeats: AggregatedMemorySlice | null;
  };
}

const aggregateMemorySlice = (runs: RunResult[]): AggregatedMemorySlice | null => {
  if (runs.length === 0) return null;

  const clientBaselines = runs.map((run) => run.memBefore.rss);
  const serverBaselines = runs.map((run) => run.serverBefore.rss);
  const combinedBaselines = runs.map((run) => run.memBefore.rss + run.serverBefore.rss);
  const peakDeltas = runs.map((run) => diffMem(run.memPeak, run.memBefore));
  const serverPeakDeltas = runs.map((run) => diffServer(run.serverPeak, run.serverBefore));
  const combinedPeakDeltas = runs.map((_run, index) => ({
    rss: (peakDeltas[index]?.rss ?? 0) + (serverPeakDeltas[index]?.rss ?? 0),
  }));
  const retainedDeltas = runs.map((run) => diffMem(run.memAfter, run.memBefore));
  const serverRetainedDeltas = runs.map((run) => diffServer(run.serverAfter, run.serverBefore));
  const combinedRetainedDeltas = runs.map((_run, index) => ({
    rss: (retainedDeltas[index]?.rss ?? 0) + (serverRetainedDeltas[index]?.rss ?? 0),
  }));

  return {
    repeats: runs.length,
    setupTime: summarizeNumbers(runs.map((run) => run.setupTime)),
    teardownTime: summarizeNumbers(runs.map((run) => run.teardownTime)),
    baseline: {
      clientRss: summarizeNumbers(clientBaselines),
      serverRss: summarizeNumbers(serverBaselines),
      combinedRss: summarizeNumbers(combinedBaselines),
    },
    peakDelta: summarizeMemDelta(peakDeltas),
    serverPeakDelta: { rss: summarizeNumbers(serverPeakDeltas.map((delta) => delta.rss)) },
    combinedPeakDelta: { rss: summarizeNumbers(combinedPeakDeltas.map((delta) => delta.rss)) },
    retainedDelta: summarizeMemDelta(retainedDeltas),
    serverRetainedDelta: {
      rss: summarizeNumbers(serverRetainedDeltas.map((delta) => delta.rss)),
    },
    combinedRetainedDelta: {
      rss: summarizeNumbers(combinedRetainedDeltas.map((delta) => delta.rss)),
    },
  };
};

const aggregateRunResults = (runResults: RunResult[]): AggregatedRunResult[] => {
  const groups = new Map<string, RunResult[]>();
  for (const run of runResults) {
    const key = `${run.adapter}::${run.scenario}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(run);
    groups.set(key, bucket);
  }

  return Array.from(groups.values()).map((runs) => {
    const firstRun = runs[0];
    if (!firstRun) {
      throw new Error('aggregateRunResults received an empty run group');
    }

    const fullSlice = aggregateMemorySlice(runs);
    if (!fullSlice) {
      throw new Error('aggregateMemorySlice returned null for a non-empty run group');
    }
    const operationNames = [
      ...new Set(runs.flatMap((run) => run.results.map((result) => result.name))),
    ];

    const operations = operationNames.map<AggregatedOperation>((name) => {
      const summaries = runs
        .map((run) => run.results.find((result) => result.name === name))
        .filter((result): result is ScenarioResult => result !== undefined)
        .map((result) => ({
          p50: median(result.timings),
          p95: percentile(result.timings, 95),
          p99: percentile(result.timings, 99),
          min: Math.min(...result.timings),
          max: Math.max(...result.timings),
          mean: mean(result.timings),
          stddev: stddev(result.timings),
          ops: result.ops,
          iterationRetainedDelta: result.iterationRetainedDelta ?? [],
          stackAttribution: result.attribution?.filter(isStackAttribution) ?? [],
        }));

      return {
        name,
        repeats: summaries.length,
        p50: summarizeNumbers(summaries.map((summary) => summary.p50)),
        p95: summarizeNumbers(summaries.map((summary) => summary.p95)),
        p99: summarizeNumbers(summaries.map((summary) => summary.p99)),
        min: summarizeNumbers(summaries.map((summary) => summary.min)),
        max: summarizeNumbers(summaries.map((summary) => summary.max)),
        mean: summarizeNumbers(summaries.map((summary) => summary.mean)),
        stddev: summarizeNumbers(summaries.map((summary) => summary.stddev)),
        ops: summaries.every((summary) => summary.ops !== undefined)
          ? summarizeNumbers(summaries.map((summary) => summary.ops ?? 0))
          : null,
        iterationRetainedDelta: summaries.some(
          (summary) => summary.iterationRetainedDelta.length > 0,
        )
          ? summarizeMemDelta(summaries.flatMap((summary) => summary.iterationRetainedDelta))
          : null,
        stackAttribution: summarizeStackAttribution(
          summaries.flatMap((summary) => summary.stackAttribution),
        ),
      };
    });

    return {
      adapter: firstRun.adapter,
      scenario: firstRun.scenario,
      repeats: fullSlice.repeats,
      setupTime: fullSlice.setupTime,
      teardownTime: fullSlice.teardownTime,
      baseline: fullSlice.baseline,
      peakDelta: fullSlice.peakDelta,
      serverPeakDelta: fullSlice.serverPeakDelta,
      combinedPeakDelta: fullSlice.combinedPeakDelta,
      retainedDelta: fullSlice.retainedDelta,
      serverRetainedDelta: fullSlice.serverRetainedDelta,
      combinedRetainedDelta: fullSlice.combinedRetainedDelta,
      errors: runs.map((run) => run.error).filter((error): error is string => error !== undefined),
      runs,
      operations,
      repeatSlices: {
        firstRepeat: aggregateMemorySlice(runs.filter((run) => run.repeatIndex === 1)),
        warmedRepeats: aggregateMemorySlice(runs.filter((run) => run.repeatIndex > 1)),
      },
    };
  });
};

// ─── Output ───

const printTable = (runResults: RunResult[]) => {
  const aggregatedRuns = aggregateRunResults(runResults);
  const adapters = [...new Set(aggregatedRuns.map((r) => r.adapter))];
  const scenarios = [...new Set(aggregatedRuns.map((r) => r.scenario))];

  for (const scenarioName of scenarios) {
    const scenarioRuns = aggregatedRuns.filter((r) => r.scenario === scenarioName);

    console.log(`\n═══ ${scenarioName} ${'═'.repeat(60 - scenarioName.length)}`);

    // Setup/teardown times + memory
    for (const run of scenarioRuns) {
      if (run.errors.length > 0) {
        console.log(`  ${run.adapter}: FAILED — ${run.errors.join('; ')}`);
        continue;
      }
      console.log(
        `  ${run.adapter}: setup med ${fmt(run.setupTime.median)} [${fmt(run.setupTime.min)}..${fmt(run.setupTime.max)}]` +
          `, teardown med ${fmt(run.teardownTime.median)} [${fmt(run.teardownTime.min)}..${fmt(run.teardownTime.max)}]` +
          ` | baseline rss client ${MB(run.baseline.clientRss.median)}` +
          `, server ${MB(run.baseline.serverRss.median)}` +
          `, combined ${MB(run.baseline.combinedRss.median)}` +
          ` | peak Δ rss med ${MB(run.peakDelta.rss.median)} [${MB(run.peakDelta.rss.min)}..${MB(run.peakDelta.rss.max)}]` +
          `, heap ${MB(run.peakDelta.heapUsed.median)}, wasm ${MB(run.peakDelta.arrayBuffers.median)}` +
          ` | server peak Δ rss med ${MB(run.serverPeakDelta.rss.median)} [${MB(run.serverPeakDelta.rss.min)}..${MB(run.serverPeakDelta.rss.max)}]` +
          ` | combined peak Δ rss med ${MB(run.combinedPeakDelta.rss.median)} [${MB(run.combinedPeakDelta.rss.min)}..${MB(run.combinedPeakDelta.rss.max)}]` +
          ` | retained Δ rss med ${MB(run.retainedDelta.rss.median)} [${MB(run.retainedDelta.rss.min)}..${MB(run.retainedDelta.rss.max)}]` +
          `, heap ${MB(run.retainedDelta.heapUsed.median)}, wasm ${MB(run.retainedDelta.arrayBuffers.median)}` +
          ` | server retained Δ rss med ${MB(run.serverRetainedDelta.rss.median)} [${MB(run.serverRetainedDelta.rss.min)}..${MB(run.serverRetainedDelta.rss.max)}]` +
          ` | combined retained Δ rss med ${MB(run.combinedRetainedDelta.rss.median)} [${MB(run.combinedRetainedDelta.rss.min)}..${MB(run.combinedRetainedDelta.rss.max)}]`,
      );
      if (run.repeatSlices.firstRepeat || run.repeatSlices.warmedRepeats) {
        const parts: string[] = [];
        if (run.repeatSlices.firstRepeat) {
          parts.push(
            `repeat1 peak Δ rss ${MB(run.repeatSlices.firstRepeat.combinedPeakDelta.rss.median)} ` +
              `[${MB(run.repeatSlices.firstRepeat.combinedPeakDelta.rss.min)}..${MB(run.repeatSlices.firstRepeat.combinedPeakDelta.rss.max)}], ` +
              `retained Δ rss ${MB(run.repeatSlices.firstRepeat.combinedRetainedDelta.rss.median)} ` +
              `[${MB(run.repeatSlices.firstRepeat.combinedRetainedDelta.rss.min)}..${MB(run.repeatSlices.firstRepeat.combinedRetainedDelta.rss.max)}]`,
          );
        }
        if (run.repeatSlices.warmedRepeats) {
          parts.push(
            `warmed peak Δ rss ${MB(run.repeatSlices.warmedRepeats.combinedPeakDelta.rss.median)} ` +
              `[${MB(run.repeatSlices.warmedRepeats.combinedPeakDelta.rss.min)}..${MB(run.repeatSlices.warmedRepeats.combinedPeakDelta.rss.max)}], ` +
              `retained Δ rss ${MB(run.repeatSlices.warmedRepeats.combinedRetainedDelta.rss.median)} ` +
              `[${MB(run.repeatSlices.warmedRepeats.combinedRetainedDelta.rss.min)}..${MB(run.repeatSlices.warmedRepeats.combinedRetainedDelta.rss.max)}]`,
          );
        }
        console.log(`    ${parts.join(' | ')}`);
      }

      for (const operation of run.operations) {
        if (operation.iterationRetainedDelta) {
          console.log(
            `    retained/iter ${operation.name}: rss med ${MB(operation.iterationRetainedDelta.rss.median)} ` +
              `[${MB(operation.iterationRetainedDelta.rss.min)}..${MB(operation.iterationRetainedDelta.rss.max)}]` +
              `, heap ${MB(operation.iterationRetainedDelta.heapUsed.median)}, wasm ${MB(operation.iterationRetainedDelta.arrayBuffers.median)}`,
          );
        }
        if (!operation.stackAttribution) continue;
        const peakStages = Object.entries(operation.stackAttribution.peakStageCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([stage, count]) => `${stage}:${count}`)
          .join(', ');
        console.log(
          `    stack ${operation.name}: peak rss med ${MB(operation.stackAttribution.peakRssDelta.median)} | peaks ${peakStages}`,
        );
      }
    }

    // Collect all operation names from first successful run
    const opNames =
      scenarioRuns.find((r) => r.operations.length > 0)?.operations.map((r) => r.name) ?? [];
    if (opNames.length === 0) continue;

    const colW = Math.max(24, ...adapters.map((a) => a.length + 2));
    const opW = Math.max(22, ...opNames.map((n) => n.length + 2));

    // Header
    let header = `\n${'Operation'.padEnd(opW)}`;
    for (const adapter of adapters) {
      header += adapter.padStart(colW);
    }
    console.log(header);
    console.log('─'.repeat(opW + colW * adapters.length));

    // Find baseline (first adapter) for ratio calculation
    const baselineRun = scenarioRuns[0];

    for (const opName of opNames) {
      let row = opName.padEnd(opW);
      const baselineResult = baselineRun?.operations.find((r) => r.name === opName);
      const baselineMedian = baselineResult?.p50.median ?? 0;

      for (const adapter of adapters) {
        const run = scenarioRuns.find((r) => r.adapter === adapter);
        const result = run?.operations.find((r) => r.name === opName);

        if (!result || (run?.errors.length ?? 0) > 0) {
          row += '(failed)'.padStart(colW);
          continue;
        }

        const med = result.p50.median;
        const p95 = result.p95.median;
        const ratio =
          adapter !== adapters[0] && baselineMedian > 0
            ? ` (${(med / baselineMedian).toFixed(1)}x)`
            : '';

        if (run && run.repeats <= 3) {
          // Few iterations: just show median
          row += `${fmt(med)}${ratio}`.padStart(colW);
        } else {
          // Show median p50/p95 across repeated whole runs
          row += `${fmt(med)} p95:${fmt(p95)}${ratio}`.padStart(colW);
        }
      }
      console.log(row);
    }
  }
  console.log('');
};

const printJson = (runResults: RunResult[]) => {
  const output = aggregateRunResults(runResults).map((run) => ({
    adapter: run.adapter,
    scenario: run.scenario,
    repeats: run.repeats,
    errors: run.errors,
    setupTime: run.setupTime,
    teardownTime: run.teardownTime,
    baseline: run.baseline,
    peakDelta: run.peakDelta,
    serverPeakDelta: run.serverPeakDelta,
    combinedPeakDelta: run.combinedPeakDelta,
    retainedDelta: run.retainedDelta,
    serverRetainedDelta: run.serverRetainedDelta,
    combinedRetainedDelta: run.combinedRetainedDelta,
    repeatSlices: run.repeatSlices,
    operations: run.operations,
    runs: run.runs.map((rawRun) => ({
      repeat: rawRun.repeatIndex,
      peakDelta: diffMem(rawRun.memPeak, rawRun.memBefore),
      serverPeakDelta: diffServer(rawRun.serverPeak, rawRun.serverBefore),
      combinedPeakDelta: {
        rss:
          diffMem(rawRun.memPeak, rawRun.memBefore).rss +
          diffServer(rawRun.serverPeak, rawRun.serverBefore).rss,
      },
      retainedDelta: diffMem(rawRun.memAfter, rawRun.memBefore),
      serverRetainedDelta: diffServer(rawRun.serverAfter, rawRun.serverBefore),
      combinedRetainedDelta: {
        rss:
          diffMem(rawRun.memAfter, rawRun.memBefore).rss +
          diffServer(rawRun.serverAfter, rawRun.serverBefore).rss,
      },
      adapter: rawRun.adapter,
      scenario: rawRun.scenario,
      setupTime: rawRun.setupTime,
      teardownTime: rawRun.teardownTime,
      error: rawRun.error ?? null,
      memory: {
        before: rawRun.memBefore,
        peak: rawRun.memPeak,
        after: rawRun.memAfter,
        serverBefore: rawRun.serverBefore,
        serverPeak: rawRun.serverPeak,
        serverAfter: rawRun.serverAfter,
        combinedBefore: {
          rss: rawRun.memBefore.rss + rawRun.serverBefore.rss,
        },
        combinedPeak: {
          rss: rawRun.memPeak.rss + rawRun.serverPeak.rss,
        },
        combinedAfter: {
          rss: rawRun.memAfter.rss + rawRun.serverAfter.rss,
        },
      },
      operations: rawRun.results.map((result) => ({
        name: result.name,
        iterations: result.timings.length,
        min: Math.min(...result.timings),
        p50: median(result.timings),
        p95: percentile(result.timings, 95),
        p99: percentile(result.timings, 99),
        max: Math.max(...result.timings),
        mean: mean(result.timings),
        stddev: stddev(result.timings),
        ops: result.ops ?? null,
        memory: result.memory ?? null,
        iterationRetainedDelta: result.iterationRetainedDelta ?? null,
        attribution: result.attribution ?? null,
      })),
    })),
    operationAttributionSummary: run.operations.map((operation) => ({
      name: operation.name,
      iterationRetainedDelta: operation.iterationRetainedDelta,
      stackAttribution: operation.stackAttribution,
    })),
  }));
  console.log(JSON.stringify(output, null, 2));
};

// ─── Main ───

const main = async () => {
  const adapters = await loadAdapters();
  const scenarios = await loadScenarios();

  if (adapters.length === 0) {
    console.error('No adapters matched filter:', adapterFilter);
    process.exit(1);
  }
  if (scenarios.length === 0) {
    console.error('No scenarios matched filter:', scenarioFilter);
    process.exit(1);
  }

  if (!jsonOutput) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log(' prisma-pglite-bridge benchmark');
    console.log(` Adapters: ${adapters.map((a) => a.name).join(', ')}`);
    console.log(` Scenarios: ${scenarios.map(([n]) => n).join(', ')}`);
    console.log(` Iterations: ${iterations} (+1 warmup)`);
    console.log(` Whole-run repeats: ${repeat}`);
    if (typeof globalThis.gc !== 'function') {
      console.log(' ⚠ Run with --expose-gc for accurate memory tracking');
    }
    console.log('═══════════════════════════════════════════════════════════════');
  }

  if (!jsonOutput) console.log('\nGenerating schema SQL...');
  const schemaSql = generateSchemaSql();
  if (!jsonOutput) console.log('Schema ready.\n');

  const allResults: RunResult[] = [];

  for (let repeatIndex = 1; repeatIndex <= repeat; repeatIndex++) {
    if (!jsonOutput && repeat > 1) {
      console.log(`\nRepeat ${repeatIndex}/${repeat}`);
    }
    for (const [scenarioName, scenario] of scenarios) {
      for (const harness of adapters) {
        if (!jsonOutput) {
          process.stdout.write(
            `▸ ${harness.name} × ${scenarioName} [run ${repeatIndex}/${repeat}]...`,
          );
        }
        const result = await runAdapterScenario(harness, scenarioName, scenario, schemaSql);
        result.repeatIndex = repeatIndex;
        allResults.push(result);
        if (!jsonOutput) {
          console.log(result.error ? ` ✗ ${result.error}` : ' ✓');
        }
      }
    }
  }

  if (jsonOutput) {
    printJson(allResults);
  } else {
    printTable(allResults);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
