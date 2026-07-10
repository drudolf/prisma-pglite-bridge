import {
  ERROR_RESPONSE,
  MAX_BACKEND_MESSAGE_LENGTH,
  READY_FOR_QUERY,
  ROW_DESCRIPTION,
} from './constants.ts';
import { rewriteRowDescriptionInPlace, rowDescriptionNeedsRewrite } from './row-description.ts';

type BackendMessageFramerOptions = {
  suppressIntermediateReadyForQuery?: boolean;
  /**
   * Widen system-catalog "char" columns (OID 18) to text (OID 25) in
   * RowDescription frames. Required for `@prisma/adapter-pg`, which rejects
   * OID 18 — but native clients (Prisma CLI engine, psql) need the real OID;
   * with the rewrite, the engine's constraint introspection misreads
   * `pg_constraint.contype` values as text. Defaults to true (bridge path).
   */
  rewriteSystemCatalogCharOids?: boolean;
  onChunk: (chunk: Uint8Array) => void;
  onErrorResponse?: () => void;
  onReadyForQuery?: (status: number) => void;
};

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
  private readonly rewriteSystemCatalogCharOids: boolean;
  private readonly onChunk: (chunk: Uint8Array) => void;
  private readonly onErrorResponse?: () => void;
  private readonly onReadyForQuery?: (status: number) => void;
  private readonly headerScratch = new Uint8Array(4);
  private readonly heldRfq = new Uint8Array(6);
  private messageType?: number;
  private headerBytesRead = 0;
  private payloadBytesRemaining = 0;
  private rfqBytesRead = 0;
  /** Slow-path RowDescription accumulator. Set once the T-frame header is decoded
   *  and a multi-chunk payload starts arriving; cleared after rewrite + emit. */
  private rowDescBuffer?: Buffer;
  private rowDescOffset = 0;

  constructor(options: BackendMessageFramerOptions) {
    this.suppressIntermediateReadyForQuery = options.suppressIntermediateReadyForQuery ?? false;
    this.rewriteSystemCatalogCharOids = options.rewriteSystemCatalogCharOids ?? true;
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
              this.dropStaleHeldReadyForQuery();
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
            } else if (
              msgType === ROW_DESCRIPTION &&
              this.rewriteSystemCatalogCharOids &&
              rowDescriptionNeedsRewrite(chunk, offset, offset + totalLen)
            ) {
              flushPassthrough(offset);
              this.dropStaleHeldReadyForQuery();
              this.emitRewrittenRowDescription(
                Buffer.from(chunk.subarray(offset, offset + totalLen)),
              );
            } else {
              this.dropStaleHeldReadyForQuery();
              if (passthroughStart < 0) {
                passthroughStart = offset;
              }
            }
            offset += totalLen;
            continue;
          }
        }

        flushPassthrough(offset);
        this.dropStaleHeldReadyForQuery();
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
        if (this.messageType === ROW_DESCRIPTION && this.rewriteSystemCatalogCharOids) {
          // Valid RowDescription always carries at least a 2-byte fieldCount,
          // so payloadBytesRemaining is > 0 here — no zero-payload finalize needed.
          this.rowDescBuffer = Buffer.alloc(5 + this.payloadBytesRemaining);
          this.rowDescBuffer[0] = ROW_DESCRIPTION;
          this.rowDescBuffer.set(this.headerScratch, 1);
          this.rowDescOffset = 5;
          continue;
        }
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
        if (this.rowDescBuffer !== undefined) {
          this.rowDescBuffer.set(chunk.subarray(offset, offset + bytesToEmit), this.rowDescOffset);
          this.rowDescOffset += bytesToEmit;
        } else {
          this.emitChunkSlice(chunk, offset, offset + bytesToEmit);
        }
        this.payloadBytesRemaining -= bytesToEmit;
        offset += bytesToEmit;
      }
      if (this.payloadBytesRemaining === 0) {
        if (this.rowDescBuffer !== undefined) {
          const buf = this.rowDescBuffer;
          this.rowDescBuffer = undefined;
          this.emitRewrittenRowDescription(buf);
        }
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

  /** Drop a complete held RFQ once a following frame proves it was an
   *  intermediate one. No-op unless suppressing and a full RFQ is buffered. */
  private dropStaleHeldReadyForQuery(): void {
    if (this.suppressIntermediateReadyForQuery && this.rfqBytesRead === 6) {
      this.dropHeldReadyForQuery();
    }
  }

  private emitPrefix(): void {
    const prefix = new Uint8Array(5);
    /* c8 ignore next — messageType always set when emitPrefix is called */
    prefix[0] = this.messageType ?? 0;
    prefix.set(this.headerScratch, 1);
    this.onChunk(prefix);
  }

  private emitRewrittenRowDescription(buf: Buffer): void {
    rewriteRowDescriptionInPlace(buf);
    this.onChunk(buf);
  }

  private emitChunkSlice(chunk: Uint8Array, start: number, end: number): void {
    const length = end - start;
    /* c8 ignore next — callers pass end > start */
    if (length <= 0) return;

    // Always copy. No shape check on the incoming view can prove the producer
    // won't reuse the underlying memory, and pg parses pushed chunks on a
    // later tick — so a zero-copy view is never safe here. PGlite in fact
    // reuses its flush buffer: on 0.5.3 raw-stream chunks are views into the
    // WASM heap and consecutive flushes arrive at the same byteOffset,
    // overwriting earlier bytes after onRawData returns.
    this.onChunk(Buffer.from(chunk.subarray(start, end)));
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
