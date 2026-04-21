/**
 * Contracts implemented by benchmark adapters and scenarios.
 *
 * Adapter authors implement {@link AdapterHarness}; scenario authors
 * implement {@link Scenario}. The runner (`benchmark/run.ts`) wires them
 * together, aggregates {@link ScenarioResult}s across repeats, and emits
 * table or JSON output.
 */
import type { PrismaClient } from '@prisma/client';

/**
 * Describes how to sample RSS of an out-of-process database server
 * (e.g., real PostgreSQL). In-process adapters (PGlite) omit this.
 */
export interface ExternalProcessSampler {
  /** Human-readable label surfaced in output (e.g. `"postgres-server"`). */
  label: string;
  /** Returns the PIDs whose RSS should be summed. May be async. */
  listPids: () => number[] | Promise<number[]>;
}

/** Handle returned by {@link AdapterHarness.setup}; threaded through teardown/truncate. */
export interface AdapterContext {
  /** Configured Prisma client driving the scenario. */
  prisma: PrismaClient;
  /** Optional sampler for out-of-process server memory. */
  serverProcessSampler?: ExternalProcessSampler;
}

/**
 * Adapter plugin: knows how to spin up a Prisma client backed by a specific
 * driver (bridge / direct pglite / real postgres) and tear it back down.
 * Implementations live in `benchmark/adapters/*.ts`.
 */
export interface AdapterHarness {
  /** Identifier printed in reports and matched by the `--adapter` CLI flag. */
  name: string;
  /** Build a Prisma client + context. `schemaSql` is the pre-rendered migration DDL. */
  setup: (schemaSql: string) => Promise<AdapterContext>;
  /** Dispose of Prisma client, driver adapter, pool, and underlying PGlite/postgres. */
  teardown: (ctx: AdapterContext) => Promise<void>;
  /** Wipe user tables between iterations without dropping the schema. */
  truncate: (ctx: AdapterContext) => Promise<void>;
}

/** Per-operation output from a {@link Scenario}. One entry per named operation. */
export interface ScenarioResult {
  name: string;
  /** Individual timings per iteration (ms) */
  timings: number[];
  /** For throughput tests: total ops completed */
  ops?: number;
  /** Memory snapshots if applicable */
  memory?: MemorySnapshot[];
  /** Optional retained deltas per iteration */
  iterationRetainedDelta?: MemoryDelta[];
  /** Optional query/bridge phase attribution for memory-heavy paths */
  attribution?: Attribution[];
}

/** Absolute memory reading at a single point in time. All byte values. */
export interface MemorySnapshot {
  label: string;
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

/** Difference between two {@link MemorySnapshot}s (after − before). */
export interface MemoryDelta {
  label: string;
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

/**
 * Memory attribution for a single bridge exec span (one frontend message
 * or one EQP pipeline). Populated by the bridge attribution probe.
 */
export interface BridgeAttributionSpan {
  label: string;
  kind: 'message' | 'pipeline';
  messageBytes: number;
  rawBytes: number;
  chunkCount: number;
  firstChunkDelayMs: number | null;
  execDurationMs: number;
  beforeExec: MemorySnapshot;
  firstChunkBeforePush: MemorySnapshot | null;
  firstChunkAfterPush: MemorySnapshot | null;
  peakBeforePushChunkIndex: number | null;
  peakAfterPushChunkIndex: number | null;
  peakBeforePush: MemorySnapshot | null;
  peakAfterPush: MemorySnapshot | null;
  afterExec: MemorySnapshot;
}

/**
 * Memory attribution for a whole Prisma query, with per-bridge-span
 * breakdown and a `peakSource` indicating which phase drove the peak.
 */
export interface QueryAttribution {
  label: string;
  beforeQuery: MemorySnapshot;
  afterQuery: MemorySnapshot;
  peak: MemorySnapshot;
  peakSource: 'before_exec' | 'before_push' | 'after_push' | 'after_exec' | 'after_query';
  bridgeSpans: BridgeAttributionSpan[];
}

/** Single labelled checkpoint in a {@link StackAttribution} trace. */
export interface StackAttributionStage {
  stage: string;
  tMs: number;
  snapshot: MemorySnapshot;
  meta: Record<string, number | string | boolean | null> | null;
}

/**
 * Coarse stack-level memory trace (scenario.start → send → first row →
 * result built → …) emitted by `stackProbe` in `benchmark/attribution.ts`.
 * Used by the stack-breakdown scenario to attribute peak RSS to a stage.
 */
export interface StackAttribution {
  label: string;
  adapter: string;
  peakStage: string;
  peak: MemorySnapshot;
  stages: StackAttributionStage[];
}

/** Union covering both memory-attribution flavors a scenario may emit. */
export type Attribution = QueryAttribution | StackAttribution;

/**
 * A benchmark scenario: run `iterations` passes of one or more named
 * operations against `prisma` and return timings/memory per operation.
 */
export type Scenario = (prisma: PrismaClient, iterations: number) => Promise<ScenarioResult[]>;
