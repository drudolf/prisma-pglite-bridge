/**
 * PGlite bridge stream.
 *
 * A Duplex stream that replaces the TCP socket in pg.Client, routing
 * wire protocol messages directly to an in-process PGlite instance.
 *
 * pg.Client writes wire protocol bytes → bridge frames messages →
 * PGlite processes via execProtocolRawStream → bridge pushes responses back.
 *
 * Extended Query Protocol pipelines (Parse→Bind→Describe→Execute→Sync) are
 * concatenated into a single buffer and sent as one atomic execProtocolRawStream
 * call within one runExclusive. This prevents portal interleaving between
 * concurrent bridges AND reduces async overhead (1 WASM call instead of 5).
 *
 * The response from a batched pipeline contains spurious ReadyForQuery messages
 * after each sub-message (PGlite's single-user mode). These are stripped,
 * keeping only the final ReadyForQuery after Sync.
 */
import { Duplex } from 'node:stream';
import type { PGlite } from '@electric-sql/pglite';
import {
  type BridgeId,
  createBridgeId,
  extractRfqStatus,
  type SessionLock,
} from './session-lock.ts';

// Frontend message types
const PARSE = 0x50; // P
const BIND = 0x42; // B
const DESCRIBE = 0x44; // D
const EXECUTE = 0x45; // E
const CLOSE = 0x43; // C
const FLUSH = 0x48; // H
const SYNC = 0x53; // S (frontend)
const TERMINATE = 0x58; // X

// Backend message type
const READY_FOR_QUERY = 0x5a; // Z — 6 bytes: Z + length(5) + status

// Extended Query Protocol message types — must be batched until Sync
const EQP_MESSAGES = new Set([PARSE, BIND, DESCRIBE, EXECUTE, CLOSE, FLUSH]);

/**
 * Strips all intermediate ReadyForQuery messages from a response, keeping
 * only the last one. PGlite's single-user mode emits RFQ after every
 * sub-message; pg.Client expects exactly one after Sync.
 *
 * Operates in-place on the response by building a list of byte ranges to
 * keep, then assembling the result. Returns the original buffer (no copy)
 * if there are 0 or 1 RFQ messages.
 */
/** @internal — exported for testing only */
export const stripIntermediateReadyForQuery = (response: Uint8Array): Uint8Array => {
  // Quick scan: count RFQ occurrences and find their positions
  const rfqPositions: number[] = [];
  let offset = 0;

  while (offset < response.length) {
    if (offset + 5 >= response.length) break;

    if (
      response[offset] === READY_FOR_QUERY &&
      response[offset + 1] === 0x00 &&
      response[offset + 2] === 0x00 &&
      response[offset + 3] === 0x00 &&
      response[offset + 4] === 0x05
    ) {
      rfqPositions.push(offset);
      offset += 6;
    } else {
      // Skip this backend message: type(1) + length(4, big-endian)
      const b1 = response[offset + 1];
      const b2 = response[offset + 2];
      const b3 = response[offset + 3];
      const b4 = response[offset + 4];
      if (b1 === undefined || b2 === undefined || b3 === undefined || b4 === undefined) break;
      const msgLen = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
      if (msgLen < 4) break; // malformed — minimum length field is 4 (includes itself)
      offset += 1 + msgLen;
    }
  }

  if (rfqPositions.length <= 1) return response;

  // Build result: copy everything except intermediate RFQ messages (all but last)
  const removeCount = rfqPositions.length - 1;
  const resultLen = response.length - removeCount * 6;
  const result = new Uint8Array(resultLen);
  let src = 0;
  let dst = 0;
  let removeIdx = 0;

  while (src < response.length) {
    const nextRemove =
      removeIdx < removeCount ? (rfqPositions[removeIdx] ?? response.length) : response.length;
    if (src < nextRemove) {
      const copyLen = nextRemove - src;
      result.set(response.subarray(src, src + copyLen), dst);
      dst += copyLen;
      src += copyLen;
    }
    if (removeIdx < removeCount && src === rfqPositions[removeIdx]) {
      src += 6;
      removeIdx++;
    }
  }

  return result;
};

/**
 * Concatenates multiple Uint8Array views into one contiguous buffer.
 */
const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0] ?? new Uint8Array(0);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

/**
 * Duplex stream that bridges `pg.Client` to an in-process PGlite instance.
 *
 * Replaces the TCP socket in `pg.Client` via the `stream` option. Speaks
 * PostgreSQL wire protocol directly to PGlite — no TCP, no serialization
 * overhead beyond what the wire protocol requires.
 *
 * Pass to `pg.Client` or use via `createPool()` / `createPgliteAdapter()`:
 *
 * ```typescript
 * const client = new pg.Client({
 *   stream: () => new PGliteBridge(pglite),
 * });
 * ```
 */
export class PGliteBridge extends Duplex {
  private readonly pglite: PGlite;
  private readonly sessionLock: SessionLock | null;
  private readonly bridgeId: BridgeId;
  /** Incoming bytes not yet compacted into buf */
  private pending: Buffer[] = [];
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: used via this.pendingLen
  private pendingLen = 0;
  /** Compacted input buffer for message framing */
  private buf: Buffer = Buffer.alloc(0);
  private phase: 'pre_startup' | 'ready' = 'pre_startup';
  private draining = false;
  private tornDown = false;
  /** Callbacks waiting for drain to process their data */
  private drainQueue: Array<(error?: Error | null) => void> = [];
  /** Buffered EQP messages awaiting Sync */
  private pipeline: Uint8Array[] = [];
  private pipelineLen = 0;

  constructor(pglite: PGlite, sessionLock?: SessionLock) {
    super();
    this.pglite = pglite;
    this.sessionLock = sessionLock ?? null;
    this.bridgeId = createBridgeId();
  }

  // ── Socket compatibility (called by pg's Connection) ──

  connect(): this {
    setImmediate(() => this.emit('connect'));
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setTimeout(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  // ── Duplex implementation ──

  override _read(): void {
    // Data is pushed proactively when PGlite responses arrive
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    this.enqueue(callback);
  }

  /** Handles corked batches — pg.Client corks during prepared queries (P+B+D+E+S) */
  override _writev(
    chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    for (const { chunk } of chunks) {
      this.pending.push(chunk);
      this.pendingLen += chunk.length;
    }
    this.enqueue(callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.sessionLock?.release(this.bridgeId);
    this.push(null);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.tornDown = true;
    this.pipeline.length = 0;
    this.pipelineLen = 0;
    this.pending.length = 0;
    this.pendingLen = 0;
    this.sessionLock?.release(this.bridgeId);

    // Flush pending write callbacks so pg.Client doesn't hang
    const callbacks = this.drainQueue;
    this.drainQueue = [];
    for (const cb of callbacks) {
      cb(error);
    }

    callback(error);
  }

  // ── Message processing ──

  /** Merge pending chunks into buf only when needed for framing */
  private compact(): void {
    if (this.pending.length === 0) return;
    if (this.buf.length === 0 && this.pending.length === 1) {
      this.buf = this.pending[0] as Buffer;
    } else {
      this.buf = Buffer.concat([this.buf, ...this.pending]);
    }
    this.pending.length = 0;
    this.pendingLen = 0;
  }

  /**
   * Enqueue a write callback and start draining if not already running.
   * The callback is NOT called until drain has processed the data.
   */
  private enqueue(callback: (error?: Error | null) => void): void {
    this.drainQueue.push(callback);
    if (!this.draining) {
      // Errors are propagated through drainQueue callbacks, not through this promise
      this.drain().catch(() => {});
    }
  }

  /**
   * Process all pending data, looping until no new data arrives.
   * Fires all queued callbacks on completion or error.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    let error: Error | null = null;

    try {
      // Loop until no more pending data to process
      while (this.pending.length > 0 || this.buf.length > 0) {
        if (this.tornDown) break;

        if (this.phase === 'pre_startup') {
          await this.processPreStartup();
        }
        if (this.phase === 'ready') {
          await this.processMessages();
        }

        // If processMessages couldn't consume anything (incomplete message),
        // stop looping — more data will arrive via _write
        if (this.pending.length === 0) break;
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      // Release session lock on error — prevents permanent deadlock if
      // PGlite crashes mid-transaction (other bridges would wait forever)
      this.sessionLock?.release(this.bridgeId);
    } finally {
      this.draining = false;

      // Fire all waiting callbacks
      const callbacks = this.drainQueue;
      this.drainQueue = [];
      for (const cb of callbacks) {
        cb(error);
      }
    }
  }

  /**
   * Frames and processes the startup message.
   *
   * Format: [4 bytes: total length] [4 bytes: protocol version] [key\0value\0 pairs]
   * No type byte — length includes itself.
   */
  private async processPreStartup(): Promise<void> {
    this.compact();
    if (this.buf.length < 4) return;
    const len = this.buf.readInt32BE(0);
    if (this.buf.length < len) return;

    const message = this.buf.subarray(0, len);
    this.buf = this.buf.subarray(len);

    await this.acquireSession();
    await this.pglite.runExclusive(async () => {
      await this.execAndPush(message);
    });

    this.phase = 'ready';
  }

  /**
   * Frames and processes regular wire protocol messages.
   *
   * Extended Query Protocol messages (Parse, Bind, Describe, Execute, Close,
   * Flush) are buffered in `this.pipeline`. When Sync arrives, the entire
   * pipeline is concatenated and sent to PGlite as one atomic
   * execProtocolRawStream call within one runExclusive.
   *
   * SimpleQuery messages are sent directly (they're self-contained).
   */
  private async processMessages(): Promise<void> {
    this.compact();
    while (this.buf.length >= 5) {
      const len = 1 + this.buf.readInt32BE(1);
      if (len < 5 || this.buf.length < len) break;

      const message = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      const msgType = message[0] ?? 0;

      if (msgType === TERMINATE) {
        this.sessionLock?.release(this.bridgeId);
        this.push(null);
        return;
      }

      if (EQP_MESSAGES.has(msgType)) {
        this.pipeline.push(message);
        this.pipelineLen += message.length;
        continue;
      }

      if (msgType === SYNC) {
        this.pipeline.push(message);
        this.pipelineLen += message.length;
        await this.flushPipeline();
        continue;
      }

      // SimpleQuery or other standalone message
      await this.acquireSession();
      await this.pglite.runExclusive(async () => {
        await this.execAndPush(message);
      });
    }
  }

  /**
   * Sends the accumulated EQP pipeline as one atomic operation.
   *
   * All buffered messages are concatenated into a single buffer and sent
   * as one execProtocolRawStream call. This is both correct (prevents
   * portal interleaving) and fast (1 WASM call + 1 async boundary instead
   * of 5). Intermediate ReadyForQuery messages are stripped from the
   * combined response.
   */
  private async flushPipeline(): Promise<void> {
    const messages = this.pipeline;
    const totalLen = this.pipelineLen;
    this.pipeline = [];
    this.pipelineLen = 0;

    // Concatenate pipeline into one buffer
    let batch: Uint8Array;
    if (messages.length === 1) {
      batch = messages[0] ?? new Uint8Array(0);
    } else {
      batch = new Uint8Array(totalLen);
      let offset = 0;
      for (const msg of messages) {
        batch.set(msg, offset);
        offset += msg.length;
      }
    }

    await this.acquireSession();
    await this.pglite.runExclusive(async () => {
      const chunks: Uint8Array[] = [];

      await this.pglite.execProtocolRawStream(batch, {
        onRawData: (chunk: Uint8Array) => chunks.push(chunk),
      });

      if (this.tornDown || chunks.length === 0) return;

      // Single chunk: strip intermediate RFQ and push
      if (chunks.length === 1) {
        const raw = chunks[0] ?? new Uint8Array(0);
        this.trackSessionStatus(raw);
        const cleaned = stripIntermediateReadyForQuery(raw);
        if (cleaned.length > 0) this.push(cleaned);
        return;
      }

      // Multiple chunks: concat first, then strip
      const combined = concat(chunks);
      this.trackSessionStatus(combined);
      const cleaned = stripIntermediateReadyForQuery(combined);
      if (cleaned.length > 0) this.push(cleaned);
    });
  }

  /**
   * Sends a message to PGlite and pushes response chunks directly to the
   * stream as they arrive. Avoids collecting and concatenating for large
   * multi-row responses (e.g., findMany 500 rows = ~503 onRawData chunks).
   *
   * Must be called inside runExclusive.
   */
  private async execAndPush(message: Uint8Array): Promise<void> {
    let lastChunk: Uint8Array | null = null;
    await this.pglite.execProtocolRawStream(message, {
      onRawData: (chunk: Uint8Array) => {
        if (!this.tornDown && chunk.length > 0) {
          this.push(chunk);
          lastChunk = chunk;
        }
      },
    });
    if (lastChunk) this.trackSessionStatus(lastChunk);
  }

  // ── Session lock helpers ──

  private async acquireSession(): Promise<void> {
    await this.sessionLock?.acquire(this.bridgeId);
  }

  private trackSessionStatus(response: Uint8Array): void {
    if (!this.sessionLock) return;
    const status = extractRfqStatus(response);
    if (status !== null) {
      this.sessionLock.updateStatus(this.bridgeId, status);
    }
  }
}
