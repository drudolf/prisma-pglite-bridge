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
import type { TelemetrySink } from './utils/adapter-stats.ts';
import { lockWaitChannel, queryChannel } from './utils/diagnostics.ts';
import type { BridgeId, SessionLock } from './utils/session-lock.ts';
import { nsToMs } from './utils/time.ts';

// Frontend message types
const PARSE = 0x50; // P
const BIND = 0x42; // B
const DESCRIBE = 0x44; // D
const EXECUTE = 0x45; // E
const CLOSE = 0x43; // C
const FLUSH = 0x48; // H
const SYNC = 0x53; // S (frontend)
const TERMINATE = 0x58; // X

// Backend message types
const READY_FOR_QUERY = 0x5a; // Z — 6 bytes: Z + length(5) + status
const ERROR_RESPONSE = 0x45; // E — signals in-band SQL error (not a JS throw)

// Extended Query Protocol message types — must be batched until Sync
const EQP_MESSAGES = new Set([PARSE, BIND, DESCRIBE, EXECUTE, CLOSE, FLUSH]);

/**
 * Upper bound on a single backend message length declared in its 4-byte
 * header. PostgreSQL's own wire protocol maxes out around 1 GiB per
 * message; anything larger indicates a corrupted or hostile stream and
 * must not be allocated against.
 */
const MAX_BACKEND_MESSAGE_LENGTH = 1_073_741_824;

/**
 * Concatenates multiple Uint8Array views into one contiguous buffer.
 */
const concat = (parts: Uint8Array[]): Uint8Array => {
  /* c8 ignore next — parts[0] defined when length===1 */
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

type BackendMessageFramerOptions = {
  suppressIntermediateReadyForQuery?: boolean;
  onChunk: (chunk: Uint8Array) => void;
  onErrorResponse?: () => void;
  onReadyForQuery?: (status: number) => void;
};

/**
 * Frontend chunk queue that frames messages without repeatedly compacting
 * the full buffered input.
 *
 * @internal — exported for testing only
 */
export class FrontendMessageBuffer {
  private chunks: Uint8Array[] = [];
  private headIndex = 0;
  private headOffset = 0;
  private totalLength = 0;

  get length(): number {
    return this.totalLength;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.totalLength += chunk.length;
  }

  clear(): void {
    this.chunks = [];
    this.headIndex = 0;
    this.headOffset = 0;
    this.totalLength = 0;
  }

  readInt32BE(offset: number): number | undefined {
    if (offset < 0 || offset + 4 > this.totalLength) return undefined;

    const head = this.chunks[this.headIndex];
    /* c8 ignore next — head defined when totalLength > 0 */
    if (head !== undefined) {
      const start = this.headOffset + offset;
      if (start + 4 <= head.length) {
        /* c8 ignore start — bounds guaranteed by `start + 4 <= head.length` */
        const b1 = head[start] ?? 0;
        const b2 = head[start + 1] ?? 0;
        const b3 = head[start + 2] ?? 0;
        const b4 = head[start + 3] ?? 0;
        /* c8 ignore stop */
        return ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
      }
    }

    let remaining = this.headOffset + offset;
    const bytes = new Uint8Array(4);
    let writeOffset = 0;

    for (let i = this.headIndex; i < this.chunks.length && writeOffset < 4; i++) {
      const chunk = this.chunks[i];
      /* c8 ignore next — chunks between headIndex and end are always populated */
      if (chunk === undefined) return undefined;
      if (remaining >= chunk.length) {
        remaining -= chunk.length;
        continue;
      }

      const bytesToCopy = Math.min(4 - writeOffset, chunk.length - remaining);
      bytes.set(chunk.subarray(remaining, remaining + bytesToCopy), writeOffset);
      writeOffset += bytesToCopy;
      remaining = 0;
    }

    /* c8 ignore start — bytes is a fixed 4-byte Uint8Array */
    const b1 = bytes[0] ?? 0;
    const b2 = bytes[1] ?? 0;
    const b3 = bytes[2] ?? 0;
    const b4 = bytes[3] ?? 0;
    /* c8 ignore stop */
    return ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
  }

  consume(length: number): Uint8Array {
    if (length < 0 || length > this.totalLength) {
      throw new Error(`Cannot consume ${length} bytes from ${this.totalLength}-byte buffer`);
    }
    if (length === 0) return new Uint8Array(0);

    const head = this.chunks[this.headIndex];
    /* c8 ignore next — head defined when totalLength > 0 */
    if (head !== undefined) {
      const headRemaining = head.length - this.headOffset;
      if (headRemaining >= length) {
        const slice = head.subarray(this.headOffset, this.headOffset + length);
        this.headOffset += length;
        this.totalLength -= length;
        if (this.headOffset === head.length) {
          this.headIndex++;
          this.headOffset = 0;
          this.compactChunks();
        }
        return slice;
      }
    }

    const result = new Uint8Array(length);
    let writeOffset = 0;
    let remaining = length;

    while (remaining > 0) {
      const chunk = this.chunks[this.headIndex];
      /* c8 ignore next 3 — guarded by line-116 length check */
      if (chunk === undefined) {
        throw new Error('FrontendMessageBuffer underflow');
      }
      const available = chunk.length - this.headOffset;
      const bytesToCopy = Math.min(remaining, available);
      result.set(chunk.subarray(this.headOffset, this.headOffset + bytesToCopy), writeOffset);
      writeOffset += bytesToCopy;
      remaining -= bytesToCopy;
      this.headOffset += bytesToCopy;
      this.totalLength -= bytesToCopy;
      if (this.headOffset === chunk.length) {
        this.headIndex++;
        this.headOffset = 0;
        this.compactChunks();
      }
    }

    return result;
  }

  private compactChunks(): void {
    if (this.headIndex === this.chunks.length) {
      this.chunks = [];
      this.headIndex = 0;
      return;
    }

    if (this.headIndex >= 32 && this.headIndex * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.headIndex);
      this.headIndex = 0;
    }
  }
}

/**
 * Streams backend protocol messages without materializing whole responses.
 *
 * Non-RFQ payload bytes are forwarded as they arrive. ReadyForQuery frames are
 * tracked only once complete; when suppression is enabled, only the final RFQ
 * is emitted.
 *
 * @internal — exported for testing only
 */
export class BackendMessageFramer {
  private readonly suppressIntermediateReadyForQuery: boolean;
  private readonly onChunk: (chunk: Uint8Array) => void;
  private readonly onErrorResponse?: () => void;
  private readonly onReadyForQuery?: (status: number) => void;
  private readonly headerScratch = new Uint8Array(4);
  private readonly heldRfq = new Uint8Array(6);
  private messageType?: number;
  private headerBytesRead = 0;
  private payloadBytesRemaining = 0;
  private rfqBytesRead = 0;

  constructor(options: BackendMessageFramerOptions) {
    this.suppressIntermediateReadyForQuery = options.suppressIntermediateReadyForQuery ?? false;
    this.onChunk = options.onChunk;
    this.onErrorResponse = options.onErrorResponse;
    this.onReadyForQuery = options.onReadyForQuery;
  }

  write(chunk: Uint8Array): void {
    if (chunk.length === 0) return;

    let offset = 0;
    let passthroughStart = -1;
    const flushPassthrough = (end: number): void => {
      if (passthroughStart >= 0 && end > passthroughStart) {
        this.emitChunkSlice(chunk, passthroughStart, end);
        passthroughStart = -1;
      }
    };
    while (offset < chunk.length) {
      if (this.messageType === undefined) {
        // Fast path: if type + 4-byte header + full payload are all in this
        // chunk, emit the whole message as one slice. Avoids the per-message
        // prefix allocation + two downstream pushes that the byte-state-machine
        // path below performs. Falls through to the slow path when the message
        // spans chunks.
        const available = chunk.length - offset;
        if (available >= 5) {
          /* c8 ignore start — bounds guaranteed by `available >= 5` */
          const msgType = chunk[offset] ?? 0;
          const b1 = chunk[offset + 1] ?? 0;
          const b2 = chunk[offset + 2] ?? 0;
          const b3 = chunk[offset + 3] ?? 0;
          const b4 = chunk[offset + 4] ?? 0;
          /* c8 ignore stop */
          const messageLength = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
          if (messageLength < 4) {
            throw new Error(`Malformed backend message length: ${messageLength}`);
          }
          if (messageLength > MAX_BACKEND_MESSAGE_LENGTH) {
            throw new Error(
              `Backend message length ${messageLength} exceeds sanity cap ${MAX_BACKEND_MESSAGE_LENGTH}`,
            );
          }
          const totalLen = 1 + messageLength;
          if (available >= totalLen) {
            if (msgType === ERROR_RESPONSE) {
              this.onErrorResponse?.();
            }
            if (msgType === READY_FOR_QUERY && messageLength === 5) {
              flushPassthrough(offset);
              if (this.suppressIntermediateReadyForQuery && this.rfqBytesRead === 6) {
                this.dropHeldReadyForQuery();
              }
              /* c8 ignore next — messageLength === 5 for RFQ; payload is 1 byte */
              const status = chunk[offset + 5] ?? 0;
              this.heldRfq[0] = msgType;
              this.heldRfq[1] = b1;
              this.heldRfq[2] = b2;
              this.heldRfq[3] = b3;
              this.heldRfq[4] = b4;
              this.heldRfq[5] = status;
              this.rfqBytesRead = 6;
              this.onReadyForQuery?.(status);
              if (!this.suppressIntermediateReadyForQuery) {
                this.emitReadyForQuery();
                this.rfqBytesRead = 0;
              }
            } else {
              if (this.suppressIntermediateReadyForQuery && this.rfqBytesRead === 6) {
                this.dropHeldReadyForQuery();
              }
              if (passthroughStart < 0) {
                passthroughStart = offset;
              }
            }
            offset += totalLen;
            continue;
          }
        }

        flushPassthrough(offset);
        if (this.suppressIntermediateReadyForQuery && this.rfqBytesRead === 6) {
          this.dropHeldReadyForQuery();
        }
        /* c8 ignore next — offset < chunk.length guaranteed by outer while */
        this.messageType = chunk[offset] ?? 0;
        this.headerBytesRead = 0;
        this.payloadBytesRemaining = 0;
        this.rfqBytesRead = this.messageType === READY_FOR_QUERY ? 1 : 0;
        if (this.rfqBytesRead === 1) {
          this.heldRfq[0] = this.messageType;
        }
        offset++;
        continue;
      }

      if (this.headerBytesRead < 4) {
        const bytesToCopy = Math.min(4 - this.headerBytesRead, chunk.length - offset);
        const headerChunk = chunk.subarray(offset, offset + bytesToCopy);
        this.headerScratch.set(headerChunk, this.headerBytesRead);
        if (this.messageType === READY_FOR_QUERY) {
          this.heldRfq.set(headerChunk, this.rfqBytesRead);
          this.rfqBytesRead += bytesToCopy;
        }
        this.headerBytesRead += bytesToCopy;
        offset += bytesToCopy;
        if (this.headerBytesRead < 4) continue;

        /* c8 ignore start — header bytes all populated before read */
        const b1 = this.headerScratch[0] ?? 0;
        const b2 = this.headerScratch[1] ?? 0;
        const b3 = this.headerScratch[2] ?? 0;
        const b4 = this.headerScratch[3] ?? 0;
        /* c8 ignore stop */
        const messageLength = ((b1 << 24) | (b2 << 16) | (b3 << 8) | b4) >>> 0;
        if (messageLength < 4) {
          throw new Error(`Malformed backend message length: ${messageLength}`);
        }
        if (messageLength > MAX_BACKEND_MESSAGE_LENGTH) {
          throw new Error(
            `Backend message length ${messageLength} exceeds sanity cap ${MAX_BACKEND_MESSAGE_LENGTH}`,
          );
        }

        this.payloadBytesRemaining = messageLength - 4;

        if (this.messageType === ERROR_RESPONSE) {
          this.onErrorResponse?.();
        }

        if (this.isReadyForQueryFrame()) {
          continue;
        }

        this.dropHeldReadyForQuery();
        this.emitPrefix();
        if (this.payloadBytesRemaining === 0) {
          this.finishMessage();
        }
        continue;
      }

      if (this.isReadyForQueryFrame()) {
        const bytesToCopy = Math.min(this.payloadBytesRemaining, chunk.length - offset);
        const payloadChunk = chunk.subarray(offset, offset + bytesToCopy);
        this.heldRfq.set(payloadChunk, this.rfqBytesRead);
        this.rfqBytesRead += bytesToCopy;
        this.payloadBytesRemaining -= bytesToCopy;
        offset += bytesToCopy;
        /* c8 ignore next 3 — bytesToCopy ≥ 1 consumes the 1-byte RFQ payload */
        if (this.payloadBytesRemaining === 0) {
          this.finishReadyForQuery();
        }
        continue;
      }

      const bytesToEmit = Math.min(this.payloadBytesRemaining, chunk.length - offset);
      /* c8 ignore next — bytesToEmit always ≥ 1 when reached */
      if (bytesToEmit > 0) {
        this.emitChunkSlice(chunk, offset, offset + bytesToEmit);
        this.payloadBytesRemaining -= bytesToEmit;
        offset += bytesToEmit;
      }
      if (this.payloadBytesRemaining === 0) {
        this.finishMessage();
      }
    }

    flushPassthrough(offset);
  }

  flush(options?: { dropHeldReadyForQuery?: boolean }): void {
    if (options?.dropHeldReadyForQuery === true) {
      this.dropHeldReadyForQuery();
    } else if (this.suppressIntermediateReadyForQuery && this.rfqBytesRead === 6) {
      this.emitReadyForQuery();
      this.rfqBytesRead = 0;
    }
  }

  reset(): void {
    this.messageType = undefined;
    this.headerBytesRead = 0;
    this.payloadBytesRemaining = 0;
    this.rfqBytesRead = 0;
  }

  private isReadyForQueryFrame(): boolean {
    return this.messageType === READY_FOR_QUERY && this.payloadBytesRemaining === 1;
  }

  private finishReadyForQuery(): void {
    const status = this.heldRfq[5];
    /* c8 ignore next — heldRfq[5] always populated before finishReadyForQuery */
    if (status !== undefined) {
      this.onReadyForQuery?.(status);
    }

    if (!this.suppressIntermediateReadyForQuery) {
      this.emitReadyForQuery();
    }

    this.finishMessage();
  }

  private emitReadyForQuery(): void {
    this.onChunk(this.heldRfq.slice(0, 6));
  }

  private dropHeldReadyForQuery(): void {
    this.rfqBytesRead = 0;
  }

  private emitPrefix(): void {
    const prefix = new Uint8Array(5);
    /* c8 ignore next — messageType always set when emitPrefix is called */
    prefix[0] = this.messageType ?? 0;
    prefix.set(this.headerScratch, 1);
    this.onChunk(prefix);
  }

  private emitChunkSlice(chunk: Uint8Array, start: number, end: number): void {
    const length = end - start;
    /* c8 ignore next — callers pass end > start */
    if (length <= 0) return;

    // PGlite already hands us standalone Uint8Array chunks copied out of the
    // WASM heap, so when this chunk owns its full backing store we can hand pg
    // zero-copy Buffer views for arbitrary subranges. We still copy when the
    // chunk is a view into a larger backing buffer (to avoid pinning unrelated
    // trailing bytes) or when the backing store is shared (to prevent the WASM
    // runtime from mutating bytes pg is still consuming).
    if (
      chunk.byteOffset === 0 &&
      chunk.byteLength === chunk.buffer.byteLength &&
      !(chunk.buffer instanceof SharedArrayBuffer)
    ) {
      this.onChunk(Buffer.from(chunk.buffer, start, length));
      return;
    }

    const exact = Buffer.from(chunk.subarray(start, end));
    this.onChunk(exact);
  }

  private finishMessage(): void {
    this.messageType = undefined;
    this.headerBytesRead = 0;
    this.payloadBytesRemaining = 0;
    if (!this.suppressIntermediateReadyForQuery) {
      this.rfqBytesRead = 0;
    }
  }
}

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
  private readonly sessionLock?: SessionLock;
  private readonly adapterId?: symbol;
  private readonly telemetry?: TelemetrySink;
  private readonly syncToFs: boolean;
  private readonly bridgeId: BridgeId;
  /** Incoming bytes framed directly from a queued chunk buffer */
  private readonly input = new FrontendMessageBuffer();
  private phase: 'pre_startup' | 'ready' = 'pre_startup';
  private draining = false;
  private tornDown = false;
  /** Callbacks waiting for drain to process their data */
  private drainQueue: Array<(error?: Error | null) => void> = [];
  /** Buffered EQP messages awaiting Sync */
  private pipeline: Uint8Array[] = [];

  /**
   * @param pglite       PGlite instance to bridge to. The caller owns its lifecycle.
   * @param sessionLock  Shared lock that serialises access to the PGlite runtime
   *                     across multiple bridges. Omit for a standalone bridge.
   * @param adapterId    Identity tag published with diagnostics-channel events.
   *                     Omit to disable channel publication for this bridge.
   * @param telemetry    Internal sink used by `createPgliteAdapter` for built-in
   *                     stats. Not a public extension point — subscribe via
   *                     `node:diagnostics_channel` instead.
   * @param syncToFs     Whether each bridged wire-protocol call should force a
   *                     filesystem sync before returning. Disable only when
   *                     higher throughput / lower RSS is worth weaker durability.
   */
  constructor(
    pglite: PGlite,
    sessionLock?: SessionLock,
    adapterId?: symbol,
    telemetry?: TelemetrySink,
    syncToFs = true,
  ) {
    super();
    this.pglite = pglite;
    this.sessionLock = sessionLock;
    this.adapterId = adapterId;
    this.telemetry = telemetry;
    this.syncToFs = syncToFs;
    this.bridgeId = Symbol('bridge');
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
    this.input.push(chunk);
    this.enqueue(callback);
  }

  /** Handles corked batches — pg.Client corks during prepared queries (P+B+D+E+S) */
  override _writev(
    chunks: Array<{ chunk: Buffer; encoding: BufferEncoding }>,
    callback: (error?: Error | null) => void,
  ): void {
    for (const { chunk } of chunks) {
      this.input.push(chunk);
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
    this.input.clear();
    this.sessionLock?.cancel(this.bridgeId, error ?? new Error('Bridge destroyed'));

    // Flush pending write callbacks so pg.Client doesn't hang
    const callbacks = this.drainQueue;
    this.drainQueue = [];
    for (const cb of callbacks) {
      cb(error);
    }

    callback(error);
  }

  // ── Message processing ──

  /**
   * Enqueue a write callback and start draining if not already running.
   * The callback is NOT called until drain has processed the data.
   */
  private enqueue(callback: (error?: Error | null) => void): void {
    this.drainQueue.push(callback);
    if (!this.draining) {
      // Errors are propagated through drainQueue callbacks, not through this promise
      this.drain().catch(/* c8 ignore next */ () => {});
    }
  }

  /**
   * Process all pending data, looping until no new data arrives.
   * Fires all queued callbacks on completion or error.
   */
  private async drain(): Promise<void> {
    /* c8 ignore next — enqueue only starts drain when !draining */
    if (this.draining) return;
    this.draining = true;

    let error: Error | null = null;

    try {
      // Loop until no more pending data to process
      while (this.input.length > 0) {
        /* c8 ignore next — race-only: destroy after a drain iteration resolves */
        if (this.tornDown) break;
        const beforeLength = this.input.length;

        if (this.phase === 'pre_startup') {
          await this.processPreStartup();
        }
        if (this.phase === 'ready') {
          await this.processMessages();
        }

        // If processMessages couldn't consume anything (incomplete message),
        // stop looping — more data will arrive via _write
        /* c8 ignore next — loop-continue unreachable: no new input arrives mid-drain */
        if (this.input.length === 0 || this.input.length === beforeLength) break;
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
    if (this.input.length < 4) return;
    const len = this.input.readInt32BE(0);
    /* c8 ignore next — len === undefined unreachable once length ≥ 4 */
    if (len === undefined || this.input.length < len) return;

    const message = this.input.consume(len);

    const session = this.acquireSession();
    if (session) await session;
    await this.pglite.runExclusive(async () => {
      await this.streamProtocol(message, { detectErrors: false, suppressIntermediateRfq: false });
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
    while (this.input.length >= 5) {
      const msgLen = this.input.readInt32BE(1);
      /* c8 ignore next — input.length ≥ 5 guarantees readable int32 */
      if (msgLen === undefined) break;
      const len = 1 + msgLen;
      if (len < 5 || this.input.length < len) break;

      const message = this.input.consume(len);
      /* c8 ignore next — consume(len ≥ 5) returns non-empty */
      const msgType = message[0] ?? 0;

      if (msgType === TERMINATE) {
        this.sessionLock?.release(this.bridgeId);
        this.push(null);
        return;
      }

      if (EQP_MESSAGES.has(msgType)) {
        this.pipeline.push(message);
        continue;
      }

      if (msgType === SYNC) {
        this.pipeline.push(message);
        await this.flushPipeline();
        continue;
      }

      // SimpleQuery or other standalone message
      await this.runWithTiming((detectErrors) =>
        this.streamProtocol(message, { detectErrors, suppressIntermediateRfq: false }),
      );
    }
  }

  /**
   * Sends the accumulated EQP pipeline as one atomic operation.
   *
   * All buffered messages are concatenated into a single buffer and sent
   * as one execProtocolRawStream call. This is both correct (prevents
   * portal interleaving) and fast (1 WASM call + 1 async boundary instead
   * of 5). A streaming framer suppresses intermediate ReadyForQuery
   * messages while forwarding the rest of the response without
   * materializing it.
   */
  private async flushPipeline(): Promise<void> {
    const messages = this.pipeline;
    this.pipeline = [];
    const batch = concat(messages);
    await this.runWithTiming((detectErrors) =>
      this.streamProtocol(batch, { detectErrors, suppressIntermediateRfq: true }),
    );
  }

  /**
   * Acquires the session, runs the op under `pglite.runExclusive`, and
   * updates internal stats and/or publishes diagnostics events when enabled.
   * When neither internal telemetry nor diagnostics subscribers need timing,
   * skips timing entirely.
   *
   * `op` returns `false` when an `ErrorResponse` was seen without throwing
   * (protocol-level failure). Combined with the catch branch, both failure
   * modes flip `succeeded` so both `AdapterStats` and `QUERY_CHANNEL`
   * payloads stay accurate. `detectErrors` is therefore tied to whether
   * either of those consumers is active, not to timing in general.
   */
  private async runWithTiming(op: (detectErrors: boolean) => Promise<boolean>): Promise<void> {
    const wantTelemetry = this.telemetry !== undefined;
    const publishQuery = this.adapterId !== undefined && queryChannel.hasSubscribers;
    const publishLockWait = this.adapterId !== undefined && lockWaitChannel.hasSubscribers;
    const wantTiming = wantTelemetry || publishQuery || publishLockWait;
    const detectErrors = wantTelemetry || publishQuery;

    if (!wantTiming) {
      const session = this.acquireSession();
      if (session) await session;
      await this.pglite.runExclusive(async () => {
        await op(false);
      });
      return;
    }

    const lockStart = process.hrtime.bigint();
    const session = this.acquireSession();
    if (session) await session;
    const queryStart = process.hrtime.bigint();
    const lockWaitMs = nsToMs(queryStart - lockStart);
    if (wantTelemetry) {
      this.telemetry?.recordLockWait(lockWaitMs);
    }
    if (publishLockWait) {
      lockWaitChannel.publish({
        adapterId: this.adapterId,
        durationMs: lockWaitMs,
      });
    }

    let succeeded = true;
    try {
      await this.pglite.runExclusive(async () => {
        succeeded = await op(detectErrors);
      });
    } catch (err) {
      succeeded = false;
      throw err;
    } finally {
      const queryMs = nsToMs(process.hrtime.bigint() - queryStart);
      if (wantTelemetry) {
        this.telemetry?.recordQuery(queryMs, succeeded);
      }
      if (publishQuery) {
        queryChannel.publish({
          adapterId: this.adapterId,
          durationMs: queryMs,
          succeeded,
        });
      }
    }
  }

  /**
   * Sends a message (or pipelined batch) to PGlite and pushes response
   * chunks directly to the stream as they arrive. Avoids collecting and
   * concatenating for large multi-row responses (e.g., findMany 500 rows
   * = ~503 onRawData chunks).
   *
   * For pipelined Extended Query batches, pass `suppressIntermediateRfq`
   * so only the final ReadyForQuery reaches the client.
   *
   * Must be called inside runExclusive.
   */
  private async streamProtocol(
    message: Uint8Array,
    options: { detectErrors: boolean; suppressIntermediateRfq: boolean },
  ): Promise<boolean> {
    const { detectErrors, suppressIntermediateRfq } = options;
    let errSeen = false;
    const framer = new BackendMessageFramer({
      suppressIntermediateReadyForQuery: suppressIntermediateRfq,
      onChunk: (chunk) => {
        /* c8 ignore next — race-only: tornDown becomes true mid-stream */
        if (!this.tornDown && chunk.length > 0) {
          this.push(chunk);
        }
      },
      onErrorResponse: () => {
        if (detectErrors) errSeen = true;
      },
      onReadyForQuery: (status) => {
        if (this.sessionLock) {
          this.sessionLock.updateStatus(this.bridgeId, status);
        }
      },
    });

    await this.pglite.execProtocolRawStream(message, {
      syncToFs: this.syncToFs,
      onRawData: (chunk: Uint8Array) => {
        /* c8 ignore next — race-only: tornDown becomes true mid-stream */
        if (!this.tornDown) {
          framer.write(chunk);
        }
      },
    });

    framer.flush({ dropHeldReadyForQuery: this.tornDown });
    return !errSeen;
  }

  // ── Session lock helpers ──

  private acquireSession(): Promise<void> | undefined {
    return this.sessionLock?.acquire(this.bridgeId);
  }
}
