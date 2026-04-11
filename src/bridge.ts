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
 * buffered and sent as a single atomic operation. This prevents "portal does
 * not exist" errors when multiple bridges share one PGlite instance — without
 * batching, another bridge could interleave between Bind (creates portal) and
 * Execute (uses portal), destroying the portal.
 *
 * The response from a batched pipeline contains spurious ReadyForQuery messages
 * after each sub-message (PGlite's single-user mode). These are stripped,
 * keeping only the final ReadyForQuery after Sync.
 */
import { Duplex } from 'node:stream';
import type { PGlite } from '@electric-sql/pglite';

// Frontend message types
const PARSE = 0x50; // P
const BIND = 0x42; // B
const DESCRIBE = 0x44; // D
const EXECUTE = 0x45; // E
const CLOSE = 0x43; // C
const FLUSH = 0x48; // H
const SYNC = 0x53; // S (frontend) — also ParameterStatus in backend, but we only parse frontend
const SIMPLE_QUERY = 0x51; // Q
const TERMINATE = 0x58; // X

// Backend message type
const READY_FOR_QUERY = 0x5a; // Z — 6 bytes: Z + length(5) + status

// Extended Query Protocol message types — must be batched until Sync
const EQP_MESSAGES = new Set([PARSE, BIND, DESCRIBE, EXECUTE, CLOSE, FLUSH]);

/**
 * Strips a trailing ReadyForQuery from a response buffer.
 * ReadyForQuery is always exactly 6 bytes: Z(0x5a) + length(0x00000005) + status.
 * Returns the original buffer (no copy) if no trailing RFQ found.
 */
const stripTrailingReadyForQuery = (response: Uint8Array): Uint8Array => {
  if (response.length < 6) return response;
  const i = response.length - 6;
  if (
    response[i] === READY_FOR_QUERY &&
    response[i + 1] === 0x00 &&
    response[i + 2] === 0x00 &&
    response[i + 3] === 0x00 &&
    response[i + 4] === 0x05
  ) {
    return response.subarray(0, i); // subarray — zero-copy view
  }
  return response;
};

export class PGliteBridge extends Duplex {
  private readonly pglite: PGlite;
  /** Incoming bytes not yet compacted into buf */
  private pending: Buffer[] = [];
  private pendingLen = 0;
  /** Compacted input buffer for message framing */
  private buf: Buffer = Buffer.alloc(0);
  private phase: 'pre_startup' | 'ready' = 'pre_startup';
  private draining = false;
  /** Buffered EQP messages awaiting Sync */
  private pipeline: Uint8Array[] = [];

  constructor(pglite: PGlite) {
    super();
    this.pglite = pglite;
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
    // Avoid Buffer.concat on every write — append to list, only concat when framing
    this.pending.push(chunk);
    this.pendingLen += chunk.length;
    this.drain()
      .then(() => callback())
      .catch(callback);
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
    this.drain()
      .then(() => callback())
      .catch(callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.push(null);
    callback();
  }

  // ── Message processing ──

  /** Merge pending chunks into buf only when needed for framing */
  private compact(): void {
    if (this.pending.length === 0) return;
    if (this.buf.length === 0 && this.pending.length === 1) {
      // Fast path: empty buf + single chunk — use chunk directly, no copy
      this.buf = this.pending[0] as Buffer;
    } else {
      this.buf = Buffer.concat([this.buf, ...this.pending]);
    }
    this.pending.length = 0;
    this.pendingLen = 0;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      if (this.phase === 'pre_startup') {
        await this.processPreStartup();
      }
      if (this.phase === 'ready') {
        await this.processMessages();
      }
    } finally {
      this.draining = false;
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

    await this.pglite.runExclusive(async () => {
      const response = await this.execRaw(message);
      this.push(response);
    });

    this.phase = 'ready';
  }

  /**
   * Frames and processes regular wire protocol messages.
   *
   * Extended Query Protocol messages (Parse, Bind, Describe, Execute, Close,
   * Flush) are buffered in `this.pipeline`. When Sync arrives, the entire
   * pipeline is sent to PGlite as one atomic `runExclusive` call. This
   * prevents portal/statement interleaving between concurrent bridges.
   *
   * SimpleQuery messages are sent directly (they're self-contained).
   */
  private async processMessages(): Promise<void> {
    this.compact();
    while (this.buf.length >= 5) {
      const len = 1 + this.buf.readInt32BE(1);
      if (this.buf.length < len) break;

      const message = this.buf.subarray(0, len);
      this.buf = this.buf.subarray(len);
      const msgType = message[0] ?? 0;

      if (msgType === TERMINATE) {
        this.push(null);
        return;
      }

      if (EQP_MESSAGES.has(msgType)) {
        // Buffer until Sync — don't touch PGlite yet
        this.pipeline.push(message);
        continue;
      }

      if (msgType === SYNC) {
        // Pipeline complete — send all buffered messages + Sync atomically
        this.pipeline.push(message);
        await this.flushPipeline();
        continue;
      }

      // SimpleQuery or other standalone message — send directly
      await this.pglite.runExclusive(async () => {
        const response = await this.execRaw(message);
        if (response.length > 0) {
          this.push(response);
        }
      });
    }
  }

  /**
   * Sends the accumulated EQP pipeline as one atomic operation.
   *
   * Each message is processed individually through execRaw (so PGlite
   * handles framing), but all within one runExclusive to prevent portal
   * interleaving. ReadyForQuery is stripped from all responses except
   * the last (Sync), matching what pg.Client expects.
   */
  private async flushPipeline(): Promise<void> {
    const messages = this.pipeline;
    this.pipeline = [];

    await this.pglite.runExclusive(async () => {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;
        const response = await this.execRaw(msg);
        if (response.length === 0) continue;

        // Strip ReadyForQuery from all EQP responses except the last (Sync)
        if (i < messages.length - 1) {
          const stripped = stripTrailingReadyForQuery(response);
          if (stripped.length > 0) this.push(stripped);
        } else {
          this.push(response);
        }
      }
    });
  }

  /**
   * Sends a wire protocol message to PGlite and collects the response.
   * Must be called inside runExclusive — does NOT acquire the mutex itself.
   */
  private async execRaw(message: Uint8Array): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];

    await this.pglite.execProtocolRawStream(message, {
      onRawData: (chunk: Uint8Array) => chunks.push(chunk),
    });

    if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}
