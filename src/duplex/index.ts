/**
 * PGlite duplex stream.
 *
 * A Duplex stream that replaces the TCP socket in pg.Client, routing
 * wire protocol messages directly to an in-process PGlite instance.
 *
 * pg.Client writes wire protocol bytes → duplex frames messages →
 * PGlite processes via execProtocolRawStream → duplex pushes responses back.
 *
 * Extended Query Protocol pipelines (Parse→Bind→Describe→Execute→Sync) are
 * concatenated into a single buffer and sent as one atomic execProtocolRawStream
 * call within one runExclusive. This prevents portal interleaving between
 * concurrent streams AND reduces async overhead (1 WASM call instead of 5).
 *
 * Flush is a second pipeline boundary: pg drives row-limited executions
 * (rows: N, pg-cursor) with Flush and waits for the response, so those
 * batches stream immediately. Because the portal then stays suspended
 * across separate execProtocolRawStream calls, the duplex holds the
 * SessionLock until the terminating Sync (or error) so concurrent duplexes
 * cannot clobber the unnamed portal.
 *
 * The response from a Sync-terminated pipeline contains spurious
 * ReadyForQuery messages after each sub-message (PGlite's single-user
 * mode). These are stripped, keeping only the final ReadyForQuery after
 * Sync; Flush-terminated responses keep an RFQ only after an error (see
 * RfqMode).
 */
import { Duplex } from 'node:stream';

import type { PGlite, PGliteInterface } from '@electric-sql/pglite';

import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import { lockWaitChannel, queryChannel } from '../telemetry/diagnostics.ts';
import type { SessionLock } from '../utils/session-lock.ts';
import { nsToMs } from '../utils/time.ts';
import { waitPGliteReady } from '../utils/wait-pglite-ready.ts';

import { BackendMessageFramer } from './backend-framer.ts';
import {
  COPY_DATA,
  COPY_DONE,
  COPY_FAIL,
  COPY_IN_RESPONSE,
  EQP_MESSAGES,
  ERROR_RESPONSE,
  FLUSH,
  MAX_COPY_AGGREGATE_BYTES,
  MAX_MESSAGE_LENGTH,
  QUERY,
  READY_FOR_QUERY,
  RFQ_STATUS_FAILED,
  RFQ_STATUS_IDLE,
  RFQ_STATUS_IN_TRANSACTION,
  SYNC,
  TERMINATE,
} from './constants.ts';
import { sniffCopyIn } from './copy-in.ts';
import { FrontendMessageBuffer } from './frontend-buffer.ts';

// PGlite's execProtocolRawSync short-circuits X/Terminate before entering
// the Postgres backend loop, while execProtocolStream still clears its
// parsed-message array. Verified through PGlite 0.4.6 and 0.5.1;
// re-verify on upgrades.
const TERMINATE_MESSAGE = new Uint8Array([TERMINATE, 0x00, 0x00, 0x00, 0x04]);
const SYNC_MESSAGE = new Uint8Array([SYNC, 0x00, 0x00, 0x00, 0x04]);
// Keep cleanup infrequent on small queries, but bounded for large read bursts;
// these thresholds came from the adapter comparison memory profile.
const PROTOCOL_CLEANUP_RAW_BYTES = 8 * 1024 * 1024;
const PROTOCOL_CLEANUP_CALLS = 32;

type PGliteProtocolCleanupCapable = PGliteInterface & {
  execProtocolStream?: PGlite['execProtocolStream'];
};

/**
 * How ReadyForQuery frames in a protocol response are treated:
 * - `'passthrough'` — every RFQ is forwarded (startup, SimpleQuery).
 * - `'suppress'` — intermediate RFQs are dropped, the final one is emitted
 *   (Sync-terminated EQP batch; PGlite's single-user mode appends spurious
 *   RFQs after each sub-message).
 * - `'flush-boundary'` — Flush-terminated EQP batch: real Postgres sends no
 *   RFQ for Flush, so any RFQ is dropped — except after an ErrorResponse,
 *   where the RFQ PGlite emits is forwarded so pg can recover the
 *   connection (stock pg never sends a recovery Sync in rows mode).
 * - `'copy-in'` — assembled COPY FROM STDIN conversation: passthrough RFQ
 *   semantics, but the backend's CopyInResponse is dropped (the client
 *   already received the duplex's synthetic one before its data was
 *   captured).
 */
type RfqMode = 'passthrough' | 'suppress' | 'flush-boundary' | 'copy-in';

export interface PGliteDuplexOptions {
  /**
   * Shared lock that serialises access to the PGlite runtime across
   * multiple duplex streams. Omit for a standalone duplex.
   */
  sessionLock?: SessionLock;
  /**
   * Identity tag published with diagnostics-channel events. Omit to
   * disable channel publication for this duplex.
   */
  bridgeId?: symbol;
  /**
   * Internal sink used by `PGliteBridge` for built-in stats. Not a public
   * extension point — subscribe via `node:diagnostics_channel` instead.
   */
  telemetry?: TelemetrySink;
  /**
   * Maximum milliseconds to wait for the PGlite instance to become ready
   * before each bridge operation. Defaults to no timeout (waits indefinitely).
   */
  timeout?: number;
  /**
   * Whether each wire-protocol call should force a filesystem sync before
   * returning. Disable only when higher throughput / lower RSS is worth
   * weaker durability. Default `true`.
   */
  syncToFs?: boolean;
  /**
   * Widen system-catalog "char" columns (OID 18) to text (OID 25) in
   * RowDescription frames. Required for `@prisma/adapter-pg`, which rejects
   * OID 18. Native clients (Prisma CLI engine, psql) need the real OID —
   * `PGliteServer` disables this. Default `true`.
   */
  rewriteSystemCatalogCharOids?: boolean;
  /**
   * Whether the underlying PGlite still accumulates parsed protocol messages
   * during raw streaming, requiring the bridge's periodic cleanup. PGlite
   * >= 0.5.3 (electric-sql/pglite#1030) no longer does, so `PgBridgePool`
   * passes `false` there to skip the redundant cleanup. Default `true`.
   */
  protocolCleanupNeeded?: boolean;
  /**
   * Cap on the aggregate bytes a `COPY ... FROM STDIN` capture may buffer
   * before executing (the whole copy conversation reaches PGlite as one
   * call; peak transient memory is ~2× this during assembly). Breaching it
   * discards the remainder and answers the copy with an in-band error —
   * never a teardown. Default {@link MAX_COPY_AGGREGATE_BYTES}.
   */
  copyAggregateCapBytes?: number;
}

/**
 * Duplex stream that bridges `pg.Client` to an in-process PGlite instance.
 *
 * **Most users should reach for {@link PGliteBridge} instead** — it
 * bundles `PGliteDuplex` with a pool, telemetry, snapshot/reset
 * lifecycle, and the Prisma adapter. Use `PGliteDuplex` directly only
 * when wiring a custom `pg.Client` setup that's outside the
 * `PgBridgePool` model.
 *
 * Replaces the TCP socket in `pg.Client` via the `stream` option. Speaks
 * PostgreSQL wire protocol directly to PGlite — no TCP, no serialization
 * overhead beyond what the wire protocol requires. When using multiple
 * duplexes against one PGlite, pass a shared {@link SessionLock} so
 * cross-duplex transactions don't interleave.
 *
 * ```typescript
 * const client = new pg.Client({
 *   stream: () => new PGliteDuplex(pglite),
 * });
 * ```
 */
export class PGliteDuplex extends Duplex {
  private readonly pglite: PGliteProtocolCleanupCapable;
  private readonly sessionLock?: SessionLock;
  private readonly bridgeId?: symbol;
  private readonly telemetry?: TelemetrySink;
  private readonly syncToFs: boolean;
  private readonly rewriteSystemCatalogCharOids: boolean;
  private readonly timeout?: number;
  private readonly duplexId: symbol;
  /** Incoming bytes framed directly from a queued chunk buffer */
  private readonly input = new FrontendMessageBuffer();
  private phase: 'pre_startup' | 'ready' = 'pre_startup';
  private draining = false;
  private tornDown = false;
  /** Callbacks waiting for drain to process their data */
  private drainQueue: Array<(error?: Error | null) => void> = [];
  /** Buffered EQP messages awaiting Sync. Cleared in place and reused —
   *  never reassigned. */
  private readonly pipeline: Uint8Array[] = [];
  /** Last RFQ status byte observed in a backend response — independent of
   *  SessionLock so rollback works for max=1 pools (no lock) and survives
   *  the in-flight BEGIN race (lock owner is set only on RFQ arrival). */
  private lastSeenRfqStatus?: number;
  /** In-flight `op()` from the runExclusive callback, if any. Set only once
   *  the callback has actually entered `op()` — a queued callback that fires
   *  after `tornDown` returns immediately and is never registered here, so
   *  teardown does not block on its slot. Rollback awaits this to catch the
   *  RFQ from a BEGIN that started before destroy. */
  private currentPGliteCall?: Promise<unknown>;
  /** Memoized rollback so concurrent teardown paths (e.g., `_final` then
   *  `_destroy`) don't issue duplicate `ROLLBACK` statements. */
  private rollbackPromise?: Promise<void>;
  private pendingProtocolCleanupBytes = 0;
  private pendingProtocolCleanupCalls = 0;
  private protocolCleanupUnsupported = false;
  private readonly protocolCleanupNeeded: boolean;
  /** Long-lived framer and per-call framing state. Safe as instance state
   *  because `streamProtocol` invocations are strictly sequential per duplex:
   *  its only callers are `processPreStartup`/`processMessages`, reachable
   *  only from the single-flight `drain()` loop, which awaits each protocol
   *  call before consuming more input. (`rollbackIfInTransaction` goes
   *  through `pglite.query`, never `streamProtocol`.) */
  private readonly framer: BackendMessageFramer;
  /** Reused options bag for `execProtocolRawStream`. PGlite destructures it
   *  immediately but retains the `onRawData` wrapper internally after the
   *  call returns (its raw-writer slot is never cleared), so the callback
   *  guards on `streamActive` to drop any out-of-call invocation instead of
   *  corrupting the next call's stream. */
  private readonly execOptions: {
    syncToFs: boolean;
    onRawData: (chunk: Uint8Array) => void;
  };
  /** Per-call stream state (with `rfqSeenInCall` and `streamActive` below) —
   *  safe as instance fields for the same sequential-calls reason as
   *  `framer`. */
  private errSeen = false;
  private rfqSeenInCall = false;
  private streamActive = false;
  /** In-flight `COPY ... FROM STDIN` capture: the held Query message plus
   *  the client's CopyData stream, assembled into ONE PGlite call on
   *  CopyDone/CopyFail — the WASM backend treats an exhausted input buffer
   *  mid-COPY as connection EOF and exits, so the conversation can never
   *  be split across calls. `discarding` is set on aggregate-cap breach:
   *  the remainder is swallowed and the terminator answered with a
   *  synthesized in-band error, PGlite never touched. */
  private copyCapture?: { chunks: Uint8Array[]; total: number; discarding: boolean };
  private readonly copyAggregateCapBytes: number;
  /** Resolves once the stream has fully torn down (post-`_final` rollback,
   *  post-`_destroy`). Single-shot, mirroring the `'close'` event. */
  readonly onClose: Promise<void>;

  /**
   * @param pglite   PGlite instance to bridge to. The caller owns its lifecycle.
   * @param options  See {@link PGliteDuplexOptions}.
   */
  constructor(pglite: PGlite | PGliteInterface, options: PGliteDuplexOptions = {}) {
    super();
    this.pglite = pglite;
    this.sessionLock = options.sessionLock;
    this.bridgeId = options.bridgeId;
    this.telemetry = options.telemetry;
    this.timeout = options.timeout;
    this.syncToFs = options.syncToFs ?? true;
    this.rewriteSystemCatalogCharOids = options.rewriteSystemCatalogCharOids ?? true;
    this.protocolCleanupNeeded = options.protocolCleanupNeeded ?? true;
    this.copyAggregateCapBytes = options.copyAggregateCapBytes ?? MAX_COPY_AGGREGATE_BYTES;

    this.duplexId = Symbol('duplex');
    this.onClose = new Promise<void>((resolve) => this.once('close', () => resolve()));

    this.framer = new BackendMessageFramer({
      rewriteSystemCatalogCharOids: this.rewriteSystemCatalogCharOids,
      onChunk: (chunk) => {
        /* c8 ignore next — race-only: tornDown becomes true mid-stream */
        if (!this.tornDown && chunk.length > 0) {
          this.push(chunk);
        }
      },
      onErrorResponse: () => {
        this.errSeen = true;
      },
      onReadyForQuery: (status) => {
        this.rfqSeenInCall = true;
        this.lastSeenRfqStatus = status;
        if (this.sessionLock) {
          this.sessionLock.updateStatus(this.duplexId, status);
        }
      },
    });
    this.execOptions = {
      syncToFs: this.syncToFs,
      onRawData: (chunk: Uint8Array) => {
        if (!this.streamActive) return;
        this.pendingProtocolCleanupBytes += chunk.byteLength;
        this.framer.write(chunk);
      },
    };
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
    // Forced disconnects (raw socket close, no Terminate) reach us here. Roll
    // back any open transaction before releasing the session lock — otherwise
    // the next bridge can run queries while PGlite is still in 'T' state and
    // observe rows from the dead transaction.
    this.rollbackIfInTransaction()
      /* v8 ignore start */
      .catch(() => {})
      /* v8 ignore stop */
      .then(() => {
        this.sessionLock?.release(this.duplexId);
        this.push(null);
        callback();
      });
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.tornDown = true;
    this.pipeline.length = 0;
    this.copyCapture = undefined;
    this.input.clear();

    // Fail queued write callbacks promptly — rollback below may await an
    // in-flight pglite call, and pg.Client must not see those writes resolve
    // successfully when the bridge is being destroyed.
    const destroyError = error ?? new Error('Bridge destroyed');
    const callbacks = this.drainQueue;
    this.drainQueue = [];
    for (const cb of callbacks) {
      cb(destroyError);
    }

    // Roll back BEFORE cancelling the session lock — cancel() unblocks waiters,
    // so any rollback after that would race with the next bridge's queries.
    this.rollbackIfInTransaction()
      /* v8 ignore start */
      .catch(() => {})
      /* v8 ignore stop */
      .then(() => {
        this.sessionLock?.cancel(this.duplexId, destroyError);
        callback(error);
      });
  }

  // ── Drain loop ──

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
        /* c8 ignore start — race-only: destroy after a drain iteration resolves */
        if (this.tornDown) break;
        const beforeLength = this.input.length;

        if (this.phase === 'pre_startup') {
          await this.processPreStartup();
        }
        if (this.phase === 'ready') {
          await this.processMessages();
        }
        /* c8 ignore stop */

        // If processMessages couldn't consume anything (incomplete message),
        // stop looping — more data will arrive via _write
        /* c8 ignore next — loop-continue unreachable: no new input arrives mid-drain */
        if (this.input.length === 0 || this.input.length === beforeLength) break;
      }
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
      // Release session lock on error — prevents permanent deadlock if
      // PGlite crashes mid-transaction (other bridges would wait forever)
      this.sessionLock?.release(this.duplexId);
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

  // ── Message framing ──

  /**
   * Frames and processes the startup message.
   *
   * Format: [4 bytes: total length] [4 bytes: protocol version] [key\0value\0 pairs]
   * No type byte — length includes itself.
   */
  private async processPreStartup(): Promise<void> {
    if (this.input.length < 4) return;
    const len = this.input.readUInt32BE(0);
    /* c8 ignore next — len === undefined unreachable once length ≥ 4 */
    if (len === undefined) return;
    // Minimum valid pre-startup frame is the 8-byte SSL/GSSENC probe (the
    // length includes itself); a smaller declared length can never complete.
    // Lengths are read unsigned, so a high-bit declared length (≥ 2 GiB)
    // lands in the sanity-cap branch below, not here. Throwing propagates
    // through the drain loop's catch: session lock released, queued write
    // callbacks failed, socket torn down.
    if (len < 8) {
      throw new Error(`Malformed startup message length: ${len}`);
    }
    if (len > MAX_MESSAGE_LENGTH) {
      throw new Error(`Startup message length ${len} exceeds sanity cap ${MAX_MESSAGE_LENGTH}`);
    }
    if (this.input.length < len) return;

    const message = this.input.consume(len);

    await this.runUntimed(async () => {
      await this.streamProtocol(message, 'passthrough');
    });

    this.phase = 'ready';
  }

  /**
   * Wrap a `pglite.runExclusive` call so the in-flight operation is tracked
   * via `currentPGliteCall`. Skip the work entirely if teardown happened
   * before our turn — otherwise a queued BEGIN would still run against PGlite
   * after `_destroy` has already returned, leaking 'T' state into the next
   * bridge's session.
   *
   * `currentPGliteCall` is set only once `op()` actually starts. A callback
   * that fires after `tornDown` returns immediately and was never observed by
   * rollback — there is no RFQ state to wait for, so blocking teardown on the
   * queued no-op would needlessly stall stream close (and any SessionLock
   * waiters behind it).
   */
  private async runUnderRunExclusive(op: () => Promise<void>): Promise<void> {
    await waitPGliteReady(this.pglite, this.timeout);

    await this.pglite.runExclusive(async () => {
      if (this.tornDown) return;
      const opPromise = op();
      this.currentPGliteCall = opPromise;
      try {
        await opPromise;
      } finally {
        this.currentPGliteCall = undefined;
      }
    });
  }

  /** Acquire the session, then run `op` under runExclusive without timing —
   *  the untimed path shared by startup and the no-telemetry query branch. */
  private async runUntimed(op: () => Promise<void>): Promise<void> {
    const session = this.acquireSession();
    if (session) await session;
    await this.runUnderRunExclusive(op);
  }

  /**
   * Frames and processes regular wire protocol messages.
   *
   * Extended Query Protocol messages (Parse, Bind, Describe, Execute, Close)
   * are buffered in `this.pipeline`. When Sync or Flush arrives, the entire
   * pipeline is concatenated and sent to PGlite as one atomic
   * execProtocolRawStream call within one runExclusive. Flush marks a portal
   * boundary — pg drives row-limited executions (rows: N, pg-cursor) with
   * Flush and waits for the response, so it must flush the pipeline like
   * Sync but with `'flush-boundary'` RFQ semantics.
   *
   * SimpleQuery messages are sent directly (they're self-contained).
   */
  private async processMessages(): Promise<void> {
    while (this.input.length >= 5) {
      const msgLen = this.input.readUInt32BE(1);
      /* c8 ignore next — input.length ≥ 5 guarantees readable int32 */
      if (msgLen === undefined) break;
      // A declared length below 4 (the length field itself) can never
      // complete — only a genuinely short buffer may wait for more bytes.
      // Mirrors the backend framer's malformed-length and sanity-cap
      // throws; the drain loop's catch turns either into failed write
      // callbacks and teardown.
      if (msgLen < 4) {
        throw new Error(`Malformed frontend message length: ${msgLen}`);
      }
      if (msgLen > MAX_MESSAGE_LENGTH) {
        throw new Error(
          `Frontend message length ${msgLen} exceeds sanity cap ${MAX_MESSAGE_LENGTH}`,
        );
      }
      const len = 1 + msgLen;
      if (this.input.length < len) break;

      const message = this.input.consume(len);
      /* c8 ignore next — consume(len ≥ 5) returns non-empty */
      const msgType = message[0] ?? 0;

      if (msgType === TERMINATE) {
        await this.rollbackIfInTransaction();
        this.sessionLock?.release(this.duplexId);
        this.push(null);
        return;
      }

      if (this.copyCapture !== undefined) {
        const capture = this.copyCapture;
        if (msgType === COPY_DATA) {
          if (!capture.discarding) {
            capture.total += message.length;
            if (capture.total > this.copyAggregateCapBytes) {
              capture.discarding = true;
              capture.chunks.length = 0;
            } else {
              capture.chunks.push(message);
            }
          }
          continue;
        }
        if (msgType === COPY_DONE || msgType === COPY_FAIL) {
          this.copyCapture = undefined;
          if (capture.discarding) {
            this.pushSyntheticError(
              '54000',
              `COPY FROM STDIN payload exceeded the aggregate cap of ${this.copyAggregateCapBytes} bytes; the copy was not executed`,
            );
            this.pushSyntheticReadyForQuery();
            continue;
          }
          capture.chunks.push(message);
          const batch = this.concatPipeline(capture.chunks);
          await this.runWithTiming(() => this.streamProtocol(batch, 'copy-in'));
          continue;
        }
        // Real Postgres treats other messages during copy-in as a protocol
        // violation (08P01); pg's copy state machine never produces them.
        throw new Error(
          `Protocol violation: unexpected frontend message 0x${msgType.toString(16)} during COPY FROM STDIN capture`,
        );
      }

      if (EQP_MESSAGES.has(msgType)) {
        this.pipeline.push(message);
        continue;
      }

      if (msgType === SYNC || msgType === FLUSH) {
        this.pipeline.push(message);
        await this.flushPipeline(msgType === SYNC ? 'suppress' : 'flush-boundary');
        continue;
      }

      if (msgType === QUERY) {
        // COPY ... FROM STDIN can never be forwarded: the backend's
        // synchronous copy-read loop treats an exhausted input buffer as
        // connection EOF and exit(1)s the WASM instance. Capture the
        // conversation instead (synthetic CopyInResponse now, the whole
        // exchange as one call on CopyDone/CopyFail) — and fail closed on
        // shapes that cannot be captured.
        const verdict = sniffCopyIn(this.queryText(message));
        if (verdict === 'capture') {
          this.copyCapture = { chunks: [message], total: message.length, discarding: false };
          this.pushSyntheticCopyInResponse();
          continue;
        }
        if (verdict === 'reject-multi') {
          this.pushSyntheticError(
            '0A000',
            'COPY FROM STDIN in a multi-statement simple query is not supported by prisma-pglite-bridge; issue it as a single statement',
          );
          this.pushSyntheticReadyForQuery();
          continue;
        }
      }

      // SimpleQuery or other standalone message
      await this.runWithTiming(() => this.streamProtocol(message, 'passthrough'));
    }
  }

  /** SQL text of a simple-protocol Query message ('Q' + int32 length +
   *  NUL-terminated string). */
  private queryText(message: Uint8Array): string {
    return Buffer.from(message.buffer, message.byteOffset + 5, message.length - 6).toString('utf8');
  }

  /** Synthetic `CopyInResponse` (text format, zero columns): sent before a
   *  captured copy-in executes, so the client starts streaming. node-pg
   *  parses the fields tolerantly and pg-copy-streams reads none of them
   *  (copy-from.js `handleCopyInResponse`, pinned by the compat suite);
   *  the backend's real CopyInResponse is dropped by the framer. */
  private pushSyntheticCopyInResponse(): void {
    this.push(Buffer.from([COPY_IN_RESPONSE, 0, 0, 0, 7, 0, 0, 0]));
  }

  /** Synthetic in-band ErrorResponse — used where the duplex answers a
   *  query itself (fail-closed copy rejection, cap breach) without PGlite
   *  ever seeing it. */
  private pushSyntheticError(code: string, message: string): void {
    const fields = Buffer.from(`SERROR\0VERROR\0C${code}\0M${message}\0\0`);
    const buf = Buffer.alloc(5 + fields.length);
    buf[0] = ERROR_RESPONSE;
    buf.writeUInt32BE(4 + fields.length, 1);
    fields.copy(buf, 5);
    this.push(buf);
  }

  /** Synthetic ReadyForQuery carrying the last status the backend actually
   *  reported — the session's transaction state is unchanged by a
   *  synthesized error, and pg's state machine needs the true byte. */
  private pushSyntheticReadyForQuery(): void {
    this.push(
      Buffer.from([READY_FOR_QUERY, 0, 0, 0, 5, this.lastSeenRfqStatus ?? RFQ_STATUS_IDLE]),
    );
  }

  /**
   * Sends the accumulated EQP pipeline as one atomic operation.
   *
   * All buffered messages are concatenated into a single buffer and sent
   * as one execProtocolRawStream call. This is both correct (prevents
   * portal interleaving within the batch) and fast (1 WASM call + 1 async
   * boundary instead of 5). A streaming framer applies the `rfqMode`
   * ReadyForQuery policy while forwarding the rest of the response without
   * materializing it.
   *
   * The pipeline is length 1 when a standalone Sync or Flush arrives with
   * nothing buffered (e.g. a bare continuation Flush from an exotic client).
   */
  private async flushPipeline(rfqMode: 'suppress' | 'flush-boundary'): Promise<void> {
    const messages = this.pipeline;
    let batch: Uint8Array;
    if (messages.length === 1) {
      // Non-empty by construction: the Sync/Flush trigger was just pushed.
      batch = messages[0] as Uint8Array;
    } else {
      batch = this.tryContiguousPipelineBatch(messages) ?? this.concatPipeline(messages);
    }
    // `batch` is fully materialized (or a view of the messages' shared
    // backing buffer — never of the array), and no new EQP message can be
    // appended mid-flush (the drain loop awaits this call before consuming
    // more input), so the array can be cleared in place and reused.
    messages.length = 0;
    await this.runWithTiming(() => this.streamProtocol(batch, rfqMode));
  }

  private tryContiguousPipelineBatch(messages: Uint8Array[]): Uint8Array | undefined {
    const first = messages[0];
    /* c8 ignore next — caller only passes non-empty pipelines */
    if (first === undefined) return undefined;

    const buffer = first.buffer;
    const start = first.byteOffset;
    let end = start + first.byteLength;
    for (let i = 1; i < messages.length; i++) {
      const part = messages[i];
      /* c8 ignore next — pipeline array has no holes */
      if (part === undefined) return undefined;
      if (part.buffer !== buffer || part.byteOffset !== end) {
        return undefined;
      }
      end += part.byteLength;
    }

    return new Uint8Array(buffer, start, end - start);
  }

  private concatPipeline(messages: Uint8Array[]): Uint8Array {
    const total = messages.reduce((sum, p) => sum + p.length, 0);
    const batch = new Uint8Array(total);
    let offset = 0;
    for (const part of messages) {
      batch.set(part, offset);
      offset += part.length;
    }
    return batch;
  }

  // ── PGlite execution ──

  /**
   * Acquires the session, runs the op under `pglite.runExclusive`, and
   * updates internal stats and/or publishes diagnostics events when enabled.
   * When neither internal telemetry nor diagnostics subscribers need timing,
   * skips timing entirely.
   *
   * `op` returns `false` when an `ErrorResponse` was seen without throwing
   * (protocol-level failure). Combined with the catch branch, both failure
   * modes flip `succeeded` so both `BridgeStats` and `QUERY_CHANNEL`
   * payloads stay accurate.
   */
  private async runWithTiming(op: () => Promise<boolean>): Promise<void> {
    const wantTelemetry = this.telemetry !== undefined;
    const publishQuery = this.bridgeId !== undefined && queryChannel.hasSubscribers;
    const publishLockWait = this.bridgeId !== undefined && lockWaitChannel.hasSubscribers;
    const wantTiming = wantTelemetry || publishQuery || publishLockWait;

    if (!wantTiming) {
      await this.runUntimed(async () => {
        await op();
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
        bridgeId: this.bridgeId,
        durationMs: lockWaitMs,
      });
    }

    let succeeded = true;
    try {
      await this.runUnderRunExclusive(async () => {
        succeeded = await op();
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
          bridgeId: this.bridgeId,
          durationMs: queryMs,
          succeeded,
        });
      }
    }
  }

  /**
   * Sends a message (or pipelined batch) to PGlite and pushes the raw protocol
   * response to the stream. Must be called inside runExclusive.
   *
   * @param message  One standalone frontend message, or a concatenated EQP
   *   batch ending in Sync or Flush.
   * @param rfqMode  ReadyForQuery policy for the response — see {@link RfqMode}.
   * @returns `false` when an ErrorResponse was observed (protocol-level
   *   failure without a throw); `true` otherwise.
   */
  private async streamProtocol(message: Uint8Array, rfqMode: RfqMode): Promise<boolean> {
    // Reset at the START of each call, not the end: a failed stream (a throw
    // from execProtocolRawStream or from framer.write on malformed input)
    // propagates before flush and may leave the framer mid-message. Resetting
    // here makes every call independent of prior failures — equivalent to the
    // fresh-framer-per-call this replaced. errSeen in particular decides
    // whether a flush-boundary response keeps its trailing RFQ; a stale value
    // from a previous call would emit a spurious RFQ and desync pg's state
    // machine.
    this.errSeen = false;
    this.rfqSeenInCall = false;
    this.framer.reset(
      rfqMode === 'suppress' || rfqMode === 'flush-boundary',
      rfqMode === 'copy-in',
    );

    // Re-check readiness inside the runExclusive mutex: the caller could
    // have closed pglite between `runUnderRunExclusive`'s pre-check and
    // our turn to run. Without this, `execProtocolRawStream` below would
    // throw a less informative error from inside the WASM runtime.
    await waitPGliteReady(this.pglite, this.timeout);

    // PGlite's raw streaming API still parses backend messages internally, but
    // does not clear that parsed-message array after returning. Keep the fast
    // streaming path, then clear PGlite's internal parsed-message state with an
    // ignored Terminate frame. `throwOnError: false` keeps the cleanup
    // best-effort if PGlite changes how that frame is handled.
    let streamFailed = false;
    this.streamActive = true;
    try {
      await this.pglite.execProtocolRawStream(message, this.execOptions);
    } catch (err) {
      streamFailed = true;
      throw err;
    } finally {
      this.streamActive = false;
      this.pendingProtocolCleanupCalls++;
      if (
        this.protocolCleanupNeeded &&
        !this.protocolCleanupUnsupported &&
        (streamFailed ||
          this.pendingProtocolCleanupBytes >= PROTOCOL_CLEANUP_RAW_BYTES ||
          this.pendingProtocolCleanupCalls >= PROTOCOL_CLEANUP_CALLS)
      ) {
        await this.clearPGliteProtocolMessages();
        this.pendingProtocolCleanupBytes = 0;
        this.pendingProtocolCleanupCalls = 0;
      }
    }

    this.framer.flush({
      dropHeldReadyForQuery: this.tornDown || (rfqMode === 'flush-boundary' && !this.errSeen),
    });

    if (rfqMode === 'flush-boundary' && this.errSeen) {
      // PGlite emits the error's ReadyForQuery immediately, but the backend
      // still enters ignore-till-sync — without a Sync it silently ignores
      // every subsequent message on the session (the next query hangs with
      // an empty response). Stock pg never sends a recovery Sync in rows
      // mode (the delivered RFQ tells it the connection already recovered),
      // so recover the backend here, inside the same runExclusive. The
      // response (ParameterStatus + another RFQ) is dropped — pg already
      // has the authoritative error RFQ.
      await this.recoverySync();
    }

    if (rfqMode === 'flush-boundary' && this.sessionLock) {
      if (!this.errSeen) {
        // The unnamed portal may be suspended awaiting a continuation
        // Execute+Flush from pg. Claim the session so no other duplex can
        // clobber the portal between batches; the next real RFQ (the Sync
        // response, or the RFQ PGlite appends to an error) releases it via
        // the onReadyForQuery → updateStatus path. Non-stealing: a duplex
        // that won the acquire race keeps its ownership and this portal is
        // doomed anyway (its continuation surfaces a portal error, not a
        // hang) — the same acquire-before-own window the transaction path
        // tolerates.
        this.sessionLock.hold(this.duplexId);
      } else if (
        !this.rfqSeenInCall &&
        // Intentionally stale read: rfqSeenInCall is false, so
        // lastSeenRfqStatus predates this call — exactly the pre-batch
        // transaction state the guard needs.
        this.lastSeenRfqStatus !== RFQ_STATUS_IN_TRANSACTION &&
        this.lastSeenRfqStatus !== RFQ_STATUS_FAILED
      ) {
        // Errored without any RFQ (unobserved on PGlite 0.4.6/0.5.3, which
        // both append one — defensive for future versions): pg cannot
        // recover this connection (stock pg sends no Sync in rows mode), so
        // drop a hold this duplex took for the now-dead portal rather than
        // blocking every other client behind a wedged connection. A real
        // transaction (status T/E) keeps ownership — it still needs its
        // COMMIT/ROLLBACK.
        this.sessionLock.release(this.duplexId);
      }
    }

    return !this.errSeen;
  }

  /** Send a bare Sync to clear the backend's ignore-till-sync state after an
   *  errored flush-boundary batch, discarding the response. Must be called
   *  inside runExclusive. If the recovery itself fails, the stream is torn
   *  down: pg already received the error RFQ and believes the connection
   *  recovered, so an unrecovered backend would silently ignore every later
   *  query — a loud connection error the pool can evict beats that. */
  private async recoverySync(): Promise<void> {
    try {
      await this.pglite.execProtocolRawStream(SYNC_MESSAGE, {
        syncToFs: false,
        onRawData: () => {},
      });
    } catch (err) {
      this.destroy(new Error('PGlite recovery Sync failed', { cause: err }));
    }
  }

  /**
   * Recover the session from a portal-suspension hold this duplex still has
   * at release time.
   *
   * Called by `PgBridgePool` when a client is released back to the pool: a
   * released client whose last query left a suspended portal open (an
   * unclosed pg-cursor) will never produce the terminating Sync — so the
   * backend keeps the dead portal AND its open implicit transaction, and
   * the hold would block every other pool client forever. Manufacture that
   * Sync here (serialized behind any in-flight exec via runExclusive), then
   * release the hold: the backend discards the portal and closes the
   * implicit transaction, so the next client starts on a genuinely idle
   * session. Without the Sync, a sibling's first ReadyForQuery reports the
   * inherited `T` and its clean release fires a misattributed
   * abandoned-transaction warning (probe-verified; plan, second amendment).
   * Committing a partially executed writing portal via Sync is stock
   * parity: with real Postgres + pg-pool, the next user's Sync on the
   * recycled connection commits the same partial effects.
   *
   * A real transaction (last RFQ status T/E) keeps ownership — releasing a
   * client mid-transaction is `rollbackAbandonedTransaction`'s job.
   *
   * The lock release rides a `finally` so waiters are unblocked on every
   * path; a failed recovery Sync destroys the duplex (recoverySync's own
   * contract), whose lock `cancel` supersedes the then-no-op release.
   */
  releaseAbandonedPortalHold(): void {
    const lock = this.sessionLock;
    if (
      lock?.isOwner(this.duplexId) === true &&
      this.lastSeenRfqStatus !== RFQ_STATUS_IN_TRANSACTION &&
      this.lastSeenRfqStatus !== RFQ_STATUS_FAILED
    ) {
      void this.runUnderRunExclusive(() => this.recoverySync())
        .finally(() => {
          lock.release(this.duplexId);
        })
        /* v8 ignore start — reachable only when waitPGliteReady rejects before the exclusive turn */
        .catch(() => {});
      /* v8 ignore stop */
    }
  }

  private async clearPGliteProtocolMessages(): Promise<void> {
    if (!this.protocolCleanupNeeded || this.protocolCleanupUnsupported) return;

    const { execProtocolStream } = this.pglite;
    if (typeof execProtocolStream !== 'function') {
      this.protocolCleanupUnsupported = true;
      return;
    }

    try {
      await execProtocolStream.call(this.pglite, TERMINATE_MESSAGE, {
        syncToFs: false,
        throwOnError: false,
      });
    } catch {
      // Best-effort cleanup for PGlite internals; preserve the original query
      // outcome if the no-op cleanup is unavailable or rejected. Disable
      // future attempts so a PGlite API change costs only one failed cleanup.
      this.protocolCleanupUnsupported = true;
    }
  }

  // ── Session lock & rollback ──

  private acquireSession(): Promise<void> | undefined {
    return this.sessionLock?.acquire(this.duplexId);
  }

  /**
   * Whether the duplex's last observed ReadyForQuery status indicates an open
   * transaction — `true` for `T` (in a transaction block) or `E` (failed
   * transaction block), `false` for `I` (idle) or before any RFQ has arrived.
   *
   * A read-only view over the private `lastSeenRfqStatus`; adds no state. It
   * exists for the pool's release-time abandoned-transaction handling
   * (`PgBridgeClient.rollbackAbandonedTransaction`), which must decide at
   * plain release whether an unclosed transaction is still open.
   */
  get inTransaction(): boolean {
    return (
      this.lastSeenRfqStatus === RFQ_STATUS_IN_TRANSACTION ||
      this.lastSeenRfqStatus === RFQ_STATUS_FAILED
    );
  }

  /**
   * Issue `ROLLBACK` against PGlite when the duplex's last observed
   * ReadyForQuery status indicates an open transaction (`T` or `E`). Safe
   * to call when no transaction is active — resolves with no effect.
   *
   * Transaction detection lives on the duplex (not on `SessionLock`) so it
   * works for both locked pools (max>1, TCP server) and standalone duplexes
   * (max=1 pool, no lock). When a `SessionLock` is present, ownership is an
   * additional safety check — a duplex whose lock was released via an error
   * path must not roll back another bridge's transaction.
   *
   * Used by `_final`, `_destroy`, and the Terminate handler. PGlite is
   * single-session, so leftover `T` state would otherwise leak into the
   * next connection.
   */
  async rollbackIfInTransaction(): Promise<void> {
    // Memoize so concurrent teardown paths (e.g., `_final` racing `_destroy`)
    // share one ROLLBACK instead of issuing duplicates.
    if (this.rollbackPromise !== undefined) return this.rollbackPromise;
    this.rollbackPromise = this.runRollback();
    return this.rollbackPromise;
  }

  private async runRollback(): Promise<void> {
    // Wait for any in-flight pglite call so its RFQ has been processed —
    // otherwise destroying mid-BEGIN would skip cleanup because the status
    // hasn't transitioned to 'T' yet.
    // The in-flight pglite call is awaited only to sequence its RFQ; the
    // result and any error are intentionally swallowed. Under current
    // orchestration runRollback always observes currentPGliteCall as falsy,
    // but the guard remains for the rare mid-call destroy path.
    /* v8 ignore start */
    if (this.currentPGliteCall) {
      await this.currentPGliteCall.catch(() => undefined);
    }
    /* v8 ignore stop */

    const status = this.lastSeenRfqStatus;
    if (status !== RFQ_STATUS_IN_TRANSACTION && status !== RFQ_STATUS_FAILED) return;

    // Defensive: rollback only runs while this duplex still owns the session
    // lock (or has none). The non-owner short-circuit cannot be reached under
    // current orchestration but stays as a guardrail.
    /* v8 ignore next */
    if (this.sessionLock !== undefined && !this.sessionLock.isOwner(this.duplexId)) return;

    try {
      // pglite.query acquires runExclusive internally — do not wrap it.
      await this.pglite.query('ROLLBACK');
      this.lastSeenRfqStatus = RFQ_STATUS_IDLE;
    } catch {
      // Best-effort cleanup. PGlite may reject ROLLBACK (e.g., already
      // auto-rolled back during shutdown) — nothing recoverable here.
    }
  }
}
