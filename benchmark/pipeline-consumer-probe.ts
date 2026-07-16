/**
 * Counting-only preload for measuring pipeline assembly in real consumers.
 *
 * This instrumentation changes hot-path cost. Discard all benchmark latency
 * output produced while it is active; the hit rate (hits / attempts) is the
 * deliverable.
 *
 * Run it directly with Node so only the benchmark process gets the preload:
 *
 *   PIPELINE_PROBE_LABEL=prisma node --import tsx --import ./benchmark/pipeline-consumer-probe.ts benchmark/run.ts --adapter prisma-pglite-bridge --scenario single-query -n 1 -w 0
 *   PIPELINE_PROBE_LABEL=drizzle node --import tsx --import ./benchmark/pipeline-consumer-probe.ts benchmark/orm/run.ts --orm drizzle -n 1 -w 0
 *
 * Counters aggregate all PGliteDuplex instances created by the benchmark
 * process. They are workload totals, not per-query numbers.
 *
 * The preload forces exit code 1 only when the process would otherwise succeed
 * and no duplex writes occurred. Existing failure exit codes are preserved.
 *
 * Do not put the preload in NODE_OPTIONS: Prisma child tools inherit it.
 */
import { writeSync } from 'node:fs';
import { PGliteDuplex } from '../src/duplex';

type WriteCallback = (error?: Error | null) => void;
type RfqMode = 'suppress' | 'flush-boundary';

interface DuplexInternals {
  _write(chunk: Buffer, encoding: BufferEncoding, callback: WriteCallback): void;
  _writev(
    chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>,
    callback: WriteCallback,
  ): void;
  pipeline: Uint8Array[];
  flushPipeline(rfqMode: RfqMode): Promise<void>;
  tryContiguousPipelineBatch(messages: Uint8Array[]): Uint8Array | undefined;
  concatPipeline(messages: Uint8Array[]): Uint8Array;
}

const stats = {
  label: process.env.PIPELINE_PROBE_LABEL ?? 'unlabelled',
  duplexWrites: { total: 0, _write: 0, _writev: 0 },
  flushPipeline: { total: 0, empty: 0, lengthOne: 0, multiPart: 0 },
  tryContiguousPipelineBatch: { attempts: 0, hits: 0, parts: 0 },
  concatPipeline: { calls: 0 },
};

const prototype = PGliteDuplex.prototype as unknown as DuplexInternals;
const wrappedMethodNames = [
  '_write',
  '_writev',
  'flushPipeline',
  'tryContiguousPipelineBatch',
  'concatPipeline',
] as const;

// This private-interface mirror is intentional. The gate turns upstream drift
// into an immediate preload error instead of silently collecting invalid data.
for (const methodName of wrappedMethodNames) {
  if (typeof prototype[methodName] !== 'function') {
    throw new TypeError(
      `PIPELINE_PROBE expected PGliteDuplex.prototype.${methodName} to be a function`,
    );
  }
}

const attachmentMarker = Symbol.for('prisma-pglite-bridge.pipeline-consumer-probe.attached');
if (Reflect.has(prototype, attachmentMarker)) {
  throw new Error('PIPELINE_PROBE is already attached to PGliteDuplex.prototype');
}
if (!Reflect.defineProperty(prototype, attachmentMarker, { value: true })) {
  throw new Error('PIPELINE_PROBE could not mark PGliteDuplex.prototype as attached');
}

const originalWrite = prototype._write;
const originalWritev = prototype._writev;
const originalFlushPipeline = prototype.flushPipeline;
const originalTryContiguousPipelineBatch = prototype.tryContiguousPipelineBatch;
const originalConcatPipeline = prototype.concatPipeline;

prototype._write = function (chunk, encoding, callback): void {
  stats.duplexWrites.total++;
  stats.duplexWrites._write++;
  originalWrite.call(this, chunk, encoding, callback);
};

prototype._writev = function (chunks, callback): void {
  stats.duplexWrites.total++;
  stats.duplexWrites._writev++;
  originalWritev.call(this, chunks, callback);
};

prototype.flushPipeline = function (rfqMode): Promise<void> {
  stats.flushPipeline.total++;
  if (this.pipeline.length === 0) stats.flushPipeline.empty++;
  else if (this.pipeline.length === 1) stats.flushPipeline.lengthOne++;
  else stats.flushPipeline.multiPart++;
  return originalFlushPipeline.call(this, rfqMode);
};

prototype.tryContiguousPipelineBatch = function (messages): Uint8Array | undefined {
  stats.tryContiguousPipelineBatch.attempts++;
  stats.tryContiguousPipelineBatch.parts += messages.length;
  const batch = originalTryContiguousPipelineBatch.call(this, messages);
  if (batch !== undefined) stats.tryContiguousPipelineBatch.hits++;
  return batch;
};

prototype.concatPipeline = function (messages): Uint8Array {
  stats.concatPipeline.calls++;
  return originalConcatPipeline.call(this, messages);
};

process.on('exit', () => {
  const currentExitCode = process.exitCode;
  if (
    stats.duplexWrites.total === 0 &&
    (currentExitCode === undefined || currentExitCode === null || Number(currentExitCode) === 0)
  ) {
    process.exitCode = 1;
  }
  writeSync(2, `PIPELINE_PROBE ${JSON.stringify(stats)}\n`);
});
