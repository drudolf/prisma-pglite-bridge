/**
 * PGlite bridge stream.
 *
 * A Duplex stream that replaces the TCP socket in pg.Client, routing
 * wire protocol messages directly to an in-process PGlite instance.
 *
 * pg.Client writes wire protocol bytes → bridge frames messages →
 * PGlite processes via execProtocolRawStream → bridge pushes responses back.
 *
 * The protocol normalizer strips spurious ReadyForQuery messages that PGlite's
 * single-user mode emits after Extended Query Protocol messages (Parse, Bind,
 * Describe, Execute, Close, Flush). Without this, strict clients like
 * tokio-postgres (Prisma's Schema Engine) reject the sequence as UnexpectedMessage.
 */
import { Duplex } from 'node:stream';
import type { PGlite } from '@electric-sql/pglite';
import { createProtocolNormalizer } from './protocol/normalizer.ts';

export class PGliteBridge extends Duplex {
  private readonly pglite: PGlite;
  private readonly normalize: ReturnType<typeof createProtocolNormalizer>;
  private buf = Buffer.alloc(0);
  private phase: 'pre_startup' | 'ready' = 'pre_startup';
  private draining = false;

  constructor(pglite: PGlite) {
    super();
    this.pglite = pglite;
    this.normalize = createProtocolNormalizer();
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

    // Startup response includes AuthenticationOk + ParameterStatus + BackendKeyData + ReadyForQuery
    // No normalization needed — ReadyForQuery is expected here
    const response = await this.execProtocol(message);
    this.push(Buffer.from(response));

    this.phase = 'ready';
  }

  /**
   * Frames and processes regular wire protocol messages.
   *
   * Format: [1 byte: type] [4 bytes: length including self] [payload]
   * Total message size = 1 + length field value.
   *
   * Messages are processed individually (not batched) so the normalizer
   * can correctly strip ReadyForQuery based on each message's type.
   */
  private async processMessages(): Promise<void> {
    while (this.buf.length >= 5) {
      const len = 1 + this.buf.readInt32BE(1);
      if (this.buf.length < len) break;

      const message = new Uint8Array(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len);

      // Terminate (X) — don't forward to PGlite, just end the stream
      if (message[0] === 0x58) {
        this.push(null);
        return;
      }

      const response = await this.execProtocol(message);
      const normalized = this.normalize(message, response);
      if (normalized.length > 0) {
        this.push(Buffer.from(normalized));
      }
    }
  }

  /**
   * Sends a wire protocol message to PGlite and collects the response.
   * Uses runExclusive to serialize access to the single-user WASM instance.
   */
  private async execProtocol(message: Uint8Array): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];

    await this.pglite.runExclusive(async () => {
      await this.pglite.execProtocolRawStream(message, {
        onRawData: (chunk: Uint8Array) => chunks.push(chunk),
      });
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
