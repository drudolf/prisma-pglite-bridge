#!/usr/bin/env tsx
/**
 * A/B benchmark for PGliteDuplex's contiguous EQP-pipeline fast path.
 *
 * The live workloads answer the first question before timing anything: does
 * node-pg actually hand the bridge multiple messages backed by one contiguous
 * buffer? The assembly workloads then bound the two possible outcomes:
 *
 * - hit: return one view instead of allocating and copying the whole pipeline;
 * - miss: scan until the first discontinuity, then allocate and copy anyway.
 *
 * Timed live repeats carry no counters. Each child first runs a separate probe,
 * restores the original methods, and only then measures either production code
 * or an exact no-fast-path flushPipeline. Parent mode interleaves variants and
 * isolates every repeat in a fresh process.
 *
 * Usage:
 *   pnpm bench:pipeline
 *   pnpm bench:pipeline -n 20000 -w 2000 -r 7 --json
 *   pnpm bench:pipeline --workloads unnamed,named,assembly-hit,assembly-miss
 */
import { spawnSync } from 'node:child_process';
import { cpus, hostname, platform, release } from 'node:os';
import { join } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

import { PGliteDuplex } from '../src/duplex/index.ts';

type Variant = 'current' | 'disabled';
type Workload = 'unnamed' | 'named' | 'assembly-hit' | 'assembly-miss';
type RfqMode = 'suppress' | 'flush-boundary';

interface ProbeStats {
  iterations: number;
  runExclusiveCalls: number;
  pipelineAttempts: number;
  pipelineHits: number;
  pipelineParts: number;
  pipelineBytes: number;
  concatCalls: number;
  concatBytes: number;
}

interface ChildResult {
  variant: Variant;
  workload: Workload;
  iterations: number;
  elapsedMs: number;
  nsPerOp: number;
  opsPerSecond: number;
  checksum: number;
  probe: ProbeStats;
}

interface RoundResult extends ChildResult {
  round: number;
}

interface Summary {
  workload: Workload;
  variant: Variant;
  medianNsPerOp: number;
  minNsPerOp: number;
  maxNsPerOp: number;
  medianOpsPerSecond: number;
  probe: ProbeStats;
}

interface DuplexInternals {
  pipeline: Uint8Array[];
  flushPipeline(rfqMode: RfqMode): Promise<void>;
  tryContiguousPipelineBatch(messages: Uint8Array[]): Uint8Array | undefined;
  concatPipeline(messages: Uint8Array[]): Uint8Array;
  runWithTiming(op: () => Promise<boolean>): Promise<void>;
  streamProtocol(message: Uint8Array, rfqMode: RfqMode): Promise<boolean>;
}

const args = process.argv.slice(2);
const getArg = (name: string, shortName?: string): string | undefined => {
  const longIndex = args.indexOf(`--${name}`);
  if (longIndex >= 0) return args[longIndex + 1];
  if (shortName !== undefined) {
    const shortIndex = args.indexOf(`-${shortName}`);
    if (shortIndex >= 0) return args[shortIndex + 1];
  }
  return undefined;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);
const positiveInteger = (name: string, fallback: number, shortName?: string): number => {
  const value = Number(getArg(name, shortName) ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const liveIterations = positiveInteger('iterations', 20_000, 'n');
const liveWarmup = positiveInteger('warmup', 2_000, 'w');
const repeats = positiveInteger('repeats', 7, 'r');
const probeIterations = positiveInteger('probe', 500);
const assemblyIterations = positiveInteger('assembly-iterations', 1_000_000);
const assemblyWarmup = positiveInteger('assembly-warmup', 100_000);
const childMode = hasFlag('child');
const jsonOutput = hasFlag('json');
const variant = getArg('variant') as Variant | undefined;
const childWorkload = getArg('workload') as Workload | undefined;
const workloadNames = (getArg('workloads') ?? 'unnamed,named,assembly-hit,assembly-miss')
  .split(',')
  .filter((value): value is Workload => value.length > 0) as Workload[];

const variants: Variant[] = ['current', 'disabled'];
const validWorkloads = new Set<Workload>(['unnamed', 'named', 'assembly-hit', 'assembly-miss']);
for (const workload of workloadNames) {
  if (!validWorkloads.has(workload)) throw new Error(`unknown workload: ${workload}`);
}

const blankProbe = (iterations: number): ProbeStats => ({
  iterations,
  runExclusiveCalls: 0,
  pipelineAttempts: 0,
  pipelineHits: 0,
  pipelineParts: 0,
  pipelineBytes: 0,
  concatCalls: 0,
  concatBytes: 0,
});

const totalBytes = (messages: Uint8Array[]): number =>
  messages.reduce((sum, message) => sum + message.byteLength, 0);

const installLiveProbe = (pglite: PGlite, stats: ProbeStats): (() => void) => {
  const prototype = PGliteDuplex.prototype as unknown as DuplexInternals;
  const originalTry = prototype.tryContiguousPipelineBatch;
  const originalConcat = prototype.concatPipeline;
  const pgliteInternals = pglite as unknown as {
    runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  };
  const originalRunExclusive = pgliteInternals.runExclusive.bind(pglite);

  prototype.tryContiguousPipelineBatch = function (messages): Uint8Array | undefined {
    stats.pipelineAttempts++;
    stats.pipelineParts += messages.length;
    stats.pipelineBytes += totalBytes(messages);
    const batch = originalTry.call(this, messages);
    if (batch !== undefined) stats.pipelineHits++;
    return batch;
  };
  prototype.concatPipeline = function (messages): Uint8Array {
    stats.concatCalls++;
    stats.concatBytes += totalBytes(messages);
    return originalConcat.call(this, messages);
  };
  pgliteInternals.runExclusive = async <T>(fn: () => Promise<T>): Promise<T> => {
    stats.runExclusiveCalls++;
    return originalRunExclusive(fn);
  };

  return () => {
    prototype.tryContiguousPipelineBatch = originalTry;
    prototype.concatPipeline = originalConcat;
    pgliteInternals.runExclusive = originalRunExclusive;
  };
};

const installDisabledFlush = (): (() => void) => {
  const prototype = PGliteDuplex.prototype as unknown as DuplexInternals;
  const originalFlush = prototype.flushPipeline;

  prototype.flushPipeline = async function (rfqMode): Promise<void> {
    const messages = this.pipeline;
    const first = messages[0];
    const batch =
      messages.length === 1 && first !== undefined ? first : this.concatPipeline(messages);
    messages.length = 0;
    await this.runWithTiming(() => this.streamProtocol(batch, rfqMode));
  };

  return () => {
    prototype.flushPipeline = originalFlush;
  };
};

const runLiveChild = async (
  workload: 'unnamed' | 'named',
  selectedVariant: Variant,
): Promise<ChildResult> => {
  const pglite = new PGlite();
  await pglite.waitReady;
  let duplex: PGliteDuplex | undefined;
  const client = new pg.Client({
    user: 'postgres',
    database: 'postgres',
    stream: () => {
      duplex = new PGliteDuplex(pglite, {
        protocolCleanupNeeded: false,
        syncToFs: false,
      });
      return duplex;
    },
  });
  await client.connect();

  const query = async (index: number): Promise<number> => {
    const value = index % 100_000;
    const result = await client.query({
      name: workload === 'named' ? 'pipeline-contiguity-named' : undefined,
      text: 'SELECT $1::int AS n',
      values: [value],
      rowMode: 'array',
    });
    return Number(result.rows[0]?.[0] ?? 0);
  };

  let checksum = 0;
  for (let i = 0; i < liveWarmup; i++) checksum += await query(i);

  const probe = blankProbe(probeIterations);
  const restoreProbe = installLiveProbe(pglite, probe);
  for (let i = 0; i < probeIterations; i++) checksum += await query(i + liveWarmup);
  restoreProbe();

  const restoreVariant = selectedVariant === 'disabled' ? installDisabledFlush() : () => {};
  const variantWarmup = Math.min(liveWarmup, 500);
  for (let i = 0; i < variantWarmup; i++) checksum += await query(i + liveWarmup);

  const start = performance.now();
  for (let i = 0; i < liveIterations; i++) checksum += await query(i);
  const elapsedMs = performance.now() - start;
  restoreVariant();

  await client.end();
  if (duplex !== undefined && !duplex.destroyed) duplex.destroy();
  if (duplex !== undefined) await duplex.onClose;
  await pglite.close();

  return {
    variant: selectedVariant,
    workload,
    iterations: liveIterations,
    elapsedMs,
    nsPerOp: (elapsedMs * 1_000_000) / liveIterations,
    opsPerSecond: (liveIterations / elapsedMs) * 1_000,
    checksum,
    probe,
  };
};

const createAssemblyParts = (contiguous: boolean): Uint8Array[] => {
  const lengths = [25, 30, 7, 10, 5];
  const buffer = new Uint8Array(lengths.reduce((sum, length) => sum + length, 0));
  for (let i = 0; i < buffer.length; i++) buffer[i] = (i * 17) & 0xff;
  let offset = 0;
  return lengths.map((length) => {
    const view = buffer.subarray(offset, offset + length);
    offset += length;
    return contiguous ? view : view.slice();
  });
};

const runAssemblyChild = (
  workload: 'assembly-hit' | 'assembly-miss',
  selectedVariant: Variant,
): ChildResult => {
  const fakePglite = {} as PGlite;
  const duplex = new PGliteDuplex(fakePglite);
  const internals = duplex as unknown as DuplexInternals;
  const messages = createAssemblyParts(workload === 'assembly-hit');
  const bytes = totalBytes(messages);
  const retained = new Array<Uint8Array>(1_024);
  let checksum = 0;

  const assemble = (index: number): void => {
    const batch =
      selectedVariant === 'current'
        ? (internals.tryContiguousPipelineBatch(messages) ?? internals.concatPipeline(messages))
        : internals.concatPipeline(messages);
    retained[index & (retained.length - 1)] = batch;
    checksum += (batch[0] ?? 0) + (batch[batch.length - 1] ?? 0) + batch.length;
  };

  for (let i = 0; i < assemblyWarmup; i++) assemble(i);
  const start = performance.now();
  for (let i = 0; i < assemblyIterations; i++) assemble(i);
  const elapsedMs = performance.now() - start;

  const hit = workload === 'assembly-hit' && selectedVariant === 'current';
  const concatCalls = hit ? 0 : assemblyIterations;
  return {
    variant: selectedVariant,
    workload,
    iterations: assemblyIterations,
    elapsedMs,
    nsPerOp: (elapsedMs * 1_000_000) / assemblyIterations,
    opsPerSecond: (assemblyIterations / elapsedMs) * 1_000,
    checksum: checksum + (retained[0]?.length ?? 0),
    probe: {
      iterations: assemblyIterations,
      runExclusiveCalls: 0,
      pipelineAttempts: selectedVariant === 'current' ? assemblyIterations : 0,
      pipelineHits: hit ? assemblyIterations : 0,
      pipelineParts: assemblyIterations * messages.length,
      pipelineBytes: assemblyIterations * bytes,
      concatCalls,
      concatBytes: concatCalls * bytes,
    },
  };
};

const childMain = async (): Promise<void> => {
  if (variant === undefined || !variants.includes(variant)) {
    throw new Error('child requires --variant current|disabled');
  }
  if (childWorkload === undefined || !validWorkloads.has(childWorkload)) {
    throw new Error('child requires a valid --workload');
  }
  const result = childWorkload.startsWith('assembly-')
    ? runAssemblyChild(childWorkload as 'assembly-hit' | 'assembly-miss', variant)
    : await runLiveChild(childWorkload as 'unnamed' | 'named', variant);
  console.log(`PIPELINE_BENCH_CHILD::${JSON.stringify(result)}`);
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const summarize = (workload: Workload, selectedVariant: Variant, runs: RoundResult[]): Summary => {
  const selected = runs.filter(
    (run) => run.workload === workload && run.variant === selectedVariant,
  );
  const ns = selected.map((run) => run.nsPerOp);
  const ops = selected.map((run) => run.opsPerSecond);
  const probe = selected[0]?.probe ?? blankProbe(0);
  return {
    workload,
    variant: selectedVariant,
    medianNsPerOp: median(ns),
    minNsPerOp: Math.min(...ns),
    maxNsPerOp: Math.max(...ns),
    medianOpsPerSecond: median(ops),
    probe,
  };
};

const runChild = (workload: Workload, selectedVariant: Variant): ChildResult => {
  const rootDir = join(import.meta.dirname, '..');
  const tsxBin = join(rootDir, 'node_modules', '.bin', 'tsx');
  const child = spawnSync(
    tsxBin,
    [
      join(import.meta.dirname, 'pipeline-contiguity.ts'),
      '--child',
      '--variant',
      selectedVariant,
      '--workload',
      workload,
      '-n',
      String(liveIterations),
      '-w',
      String(liveWarmup),
      '--probe',
      String(probeIterations),
      '--assembly-iterations',
      String(assemblyIterations),
      '--assembly-warmup',
      String(assemblyWarmup),
    ],
    {
      cwd: rootDir,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  if (child.status !== 0) {
    throw new Error(
      `${workload}/${selectedVariant} failed: ${(child.stderr || child.stdout).slice(-2_000)}`,
    );
  }
  const line = child.stdout
    .split('\n')
    .find((candidate) => candidate.startsWith('PIPELINE_BENCH_CHILD::'));
  if (line === undefined) throw new Error(`${workload}/${selectedVariant} emitted no result`);
  return JSON.parse(line.slice('PIPELINE_BENCH_CHILD::'.length)) as ChildResult;
};

const parentMain = (): void => {
  const runs: RoundResult[] = [];
  for (const workload of workloadNames) {
    for (let round = 0; round < repeats; round++) {
      const order = round % 2 === 0 ? variants : [...variants].reverse();
      for (const selectedVariant of order) {
        if (!jsonOutput) {
          process.stderr.write(
            `running ${workload} ${selectedVariant} (${round + 1}/${repeats})\n`,
          );
        }
        runs.push({ ...runChild(workload, selectedVariant), round });
      }
    }
  }

  const summaries = workloadNames.flatMap((workload) =>
    variants.map((selectedVariant) => summarize(workload, selectedVariant, runs)),
  );
  const comparisons = workloadNames.map((workload) => {
    const current = summaries.find(
      (summary) => summary.workload === workload && summary.variant === 'current',
    );
    const disabled = summaries.find(
      (summary) => summary.workload === workload && summary.variant === 'disabled',
    );
    if (current === undefined || disabled === undefined) throw new Error('missing summary');
    return {
      workload,
      currentNsPerOp: current.medianNsPerOp,
      disabledNsPerOp: disabled.medianNsPerOp,
      currentVsDisabledPct:
        ((current.medianNsPerOp - disabled.medianNsPerOp) / disabled.medianNsPerOp) * 100,
      currentSpeedup: disabled.medianNsPerOp / current.medianNsPerOp,
      probe: current.probe,
    };
  });
  const output = {
    machine: {
      hostname: hostname(),
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      node: process.version,
    },
    config: {
      liveIterations,
      liveWarmup,
      probeIterations,
      assemblyIterations,
      assemblyWarmup,
      repeats,
      workloads: workloadNames,
    },
    summaries,
    comparisons,
    runs,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log(JSON.stringify({ machine: output.machine, config: output.config }, null, 2));
  for (const comparison of comparisons) {
    const hitRate =
      comparison.probe.pipelineAttempts === 0
        ? 0
        : comparison.probe.pipelineHits / comparison.probe.pipelineAttempts;
    console.log(
      `${comparison.workload.padEnd(14)} current=${comparison.currentNsPerOp.toFixed(1)}ns ` +
        `disabled=${comparison.disabledNsPerOp.toFixed(1)}ns ` +
        `delta=${comparison.currentVsDisabledPct.toFixed(2)}% ` +
        `hits=${comparison.probe.pipelineHits}/${comparison.probe.pipelineAttempts} ` +
        `(${(hitRate * 100).toFixed(1)}%)`,
    );
  }
};

if (childMode) {
  await childMain();
} else {
  parentMain();
}
