import type { PrismaClient } from '@prisma/client';

export interface ExternalProcessSampler {
  label: string;
  listPids: () => number[] | Promise<number[]>;
}

export interface AdapterContext {
  prisma: PrismaClient;
  serverProcessSampler?: ExternalProcessSampler;
}

export interface AdapterHarness {
  name: string;
  setup: (schemaSql: string) => Promise<AdapterContext>;
  teardown: (ctx: AdapterContext) => Promise<void>;
  truncate: (ctx: AdapterContext) => Promise<void>;
}

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

export interface MemorySnapshot {
  label: string;
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

export interface MemoryDelta {
  label: string;
  rss: number;
  heapUsed: number;
  arrayBuffers: number;
}

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

export interface QueryAttribution {
  label: string;
  beforeQuery: MemorySnapshot;
  afterQuery: MemorySnapshot;
  peak: MemorySnapshot;
  peakSource: 'before_exec' | 'before_push' | 'after_push' | 'after_exec' | 'after_query';
  bridgeSpans: BridgeAttributionSpan[];
}

export interface StackAttributionStage {
  stage: string;
  tMs: number;
  snapshot: MemorySnapshot;
  meta: Record<string, number | string | boolean | null> | null;
}

export interface StackAttribution {
  label: string;
  adapter: string;
  peakStage: string;
  peak: MemorySnapshot;
  stages: StackAttributionStage[];
}

export type Attribution = QueryAttribution | StackAttribution;

export type Scenario = (prisma: PrismaClient, iterations: number) => Promise<ScenarioResult[]>;
