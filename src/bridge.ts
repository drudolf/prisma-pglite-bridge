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
 * Strips all ReadyForQuery messages from a response except the last one.
 *
 * PGlite's single-user mode sends ReadyForQuery after every sub-message in
 * a pipeline. pg.Client expects only one ReadyForQuery after Sync.
 */
const stripIntermediateReadyForQuery = (response: Uint8Array): Uint8Array => {
  // First pass: find all message boundaries and ReadyForQuery positions
  const segments: { start: number; end: number; isRfq: boolean }[] = [];
  let offset = 0;

  while (offset < response.length) {
    const type = response[offset];
    if (offset + 4 >= response.length) break;

    if (
      type === READY_FOR_QUERY &&
      response[offset + 1] === 0x00 &&
      response[offset + 2] === 0x00 &&
      response[offset + 3] === 0x00 &&
      response[offset + 4] === 0x05
    ) {
      segments.push({ start: offset, end: offset + 6, isRfq: true });
      offset += 6;
    } else {
      // Standard backend message: type(1) + length(4) + payload
      const view = new DataView(response.buffer, response.byteOffset + offset + 1, 4);
      const len = 1 + view.getInt32(0);
      segments.push({ start: offset, end: offset + len, isRfq: false });
      offset += len;
    }
  }

  // Count RFQ messages — if 0 or 1, no stripping needed
  const rfqCount = segments.filter((s) => s.isRfq).length;
  if (rfqCount <= 1) return response;

  // Keep all non-RFQ segments + the LAST RFQ
  let lastRfqSeen = false;
  const keep: { start: number; end: number }[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (!seg) continue;
    if (seg.isRfq && !lastRfqSeen) {
      lastRfqSeen = true;
      keep.unshift(seg);
    } else if (!seg.isRfq) {
      keep.unshift(seg);
    }
    // Skip intermediate RFQ segments
  }

  const total = keep.reduce((sum, s) => sum + (s.end - s.start), 0);
  const result = new Uint8Array(total);
  let pos = 0;
  for (const seg of keep) {
    result.set(response.subarray(seg.start, seg.end), pos);
    pos += seg.end - seg.start;
  }
  return result;
};

/**
 * Concatenates multiple Uint8Array messages into one buffer.
 */
const concatMessages = (messages: Uint8Array[]): Uint8Array => {
  if (messages.length === 1) return messages[0] ?? new Uint8Array(0);
  const total = messages.reduce((sum, m) => sum + m.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const msg of messages) {
    result.set(msg, offset);
    offset += msg.length;
  }
  return result;
};

export class PGliteBridge extends Duplex {
  private readonly pglite: PGlite;
  private buf = Buffer.alloc(0);
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
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain()
      .then(() => callback())
      .catch(callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.push(null);
    callback();
  }

  // ── Message processing ──

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
    if (this.buf.length < 4) return;
    const len = this.buf.readInt32BE(0);
    if (this.buf.length < len) return;

    const message = new Uint8Array(this.buf.subarray(0, len));
    this.buf = this.buf.subarray(len);

    await this.pglite.runExclusive(async () => {
      const response = await this.execRaw(message);
      this.push(Buffer.from(response));
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
    while (this.buf.length >= 5) {
      const len = 1 + this.buf.readInt32BE(1);
      if (this.buf.length < len) break;

      const message = new Uint8Array(this.buf.subarray(0, len));
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
          this.push(Buffer.from(response));
        }
      });
    }
  }

  /**
   * Sends the accumulated EQP pipeline as one atomic operation.
   * Strips intermediate ReadyForQuery messages from the response.
   */
  private async flushPipeline(): Promise<void> {
    const messages = this.pipeline;
    this.pipeline = [];

    const batch = concatMessages(messages);

    await this.pglite.runExclusive(async () => {
      const response = await this.execRaw(batch);
      const cleaned = stripIntermediateReadyForQuery(response);
      if (cleaned.length > 0) {
        this.push(Buffer.from(cleaned));
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
