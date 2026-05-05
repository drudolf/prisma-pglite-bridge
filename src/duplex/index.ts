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
 * The response from a batched pipeline contains spurious ReadyForQuery messages
 * after each sub-message (PGlite's single-user mode). These are stripped,
 * keeping only the final ReadyForQuery after Sync.
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
  EQP_MESSAGES,
  RFQ_STATUS_FAILED,
  RFQ_STATUS_IDLE,
  RFQ_STATUS_IN_TRANSACTION,
  SYNC,
  TERMINATE,
} from './constants.ts';
import { FrontendMessageBuffer } from './frontend-buffer.ts';

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
  private readonly pglite: PGlite | PGliteInterface;
  private readonly sessionLock?: SessionLock;
  private readonly bridgeId?: symbol;
  private readonly telemetry?: TelemetrySink;
  private readonly syncToFs: boolean;
  private readonly timeout?: number;
  private readonly duplexId: symbol;
  /** Incoming bytes framed directly from a queued chunk buffer */
  private readonly input = new FrontendMessageBuffer();
  private phase: 'pre_startup' | 'ready' = 'pre_startup';
  private draining = false;
  private tornDown = false;
  /** Callbacks waiting for drain to process their data */
  private drainQueue: Array<(error?: Error | null) => void> = [];
  /** Buffered EQP messages awaiting Sync */
  private pipeline: Uint8Array[] = [];
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

    this.duplexId = Symbol('duplex');
    this.onClose = new Promise<void>((resolve) => this.once('close', () => resolve()));
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
    const len = this.input.readInt32BE(0);
    /* c8 ignore next — len === undefined unreachable once length ≥ 4 */
    if (len === undefined || this.input.length < len) return;

    const message = this.input.consume(len);

    const session = this.acquireSession();
    if (session) await session;
    await this.runUnderRunExclusive(async () => {
      await this.streamProtocol(message, { detectErrors: false, suppressIntermediateRfq: false });
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
        await this.rollbackIfInTransaction();
        this.sessionLock?.release(this.duplexId);
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
    let batch: Uint8Array;
    /* c8 ignore next 3 — flushPipeline only runs after Sync is appended */
    if (messages.length === 1) {
      batch = messages[0] ?? new Uint8Array(0);
    } else {
      const total = messages.reduce((sum, p) => sum + p.length, 0);
      batch = new Uint8Array(total);
      let offset = 0;
      for (const part of messages) {
        batch.set(part, offset);
        offset += part.length;
      }
    }
    await this.runWithTiming((detectErrors) =>
      this.streamProtocol(batch, { detectErrors, suppressIntermediateRfq: true }),
    );
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
   * payloads stay accurate. `detectErrors` is therefore tied to whether
   * either of those consumers is active, not to timing in general.
   */
  private async runWithTiming(op: (detectErrors: boolean) => Promise<boolean>): Promise<void> {
    const wantTelemetry = this.telemetry !== undefined;
    const publishQuery = this.bridgeId !== undefined && queryChannel.hasSubscribers;
    const publishLockWait = this.bridgeId !== undefined && lockWaitChannel.hasSubscribers;
    const wantTiming = wantTelemetry || publishQuery || publishLockWait;
    const detectErrors = wantTelemetry || publishQuery;

    if (!wantTiming) {
      const session = this.acquireSession();
      if (session) await session;
      await this.runUnderRunExclusive(async () => {
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
        bridgeId: this.bridgeId,
        durationMs: lockWaitMs,
      });
    }

    let succeeded = true;
    try {
      await this.runUnderRunExclusive(async () => {
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
          bridgeId: this.bridgeId,
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
        this.lastSeenRfqStatus = status;
        if (this.sessionLock) {
          this.sessionLock.updateStatus(this.duplexId, status);
        }
      },
    });

    // Re-check readiness inside the runExclusive mutex: the caller could
    // have closed pglite between `runUnderRunExclusive`'s pre-check and
    // our turn to run. Without this, `execProtocolRawStream` below would
    // throw a less informative error from inside the WASM runtime.
    await waitPGliteReady(this.pglite, this.timeout);

    // Let framer.write run even during teardown so RFQ tracking stays current.
    // The onChunk handler above already gates `this.push` on tornDown to avoid
    // writing to a dead socket — keeping framer state up to date here is what
    // makes rollback decisions correct after a forced destroy. The in-flight
    // pglite call is tracked from inside the runExclusive callback in
    // `runUnderRunExclusive`, so a queued-but-not-yet-started callback never
    // pins teardown.
    await this.pglite.execProtocolRawStream(message, {
      syncToFs: this.syncToFs,
      onRawData: (chunk: Uint8Array) => {
        framer.write(chunk);
      },
    });

    framer.flush({ dropHeldReadyForQuery: this.tornDown });
    return !errSeen;
  }

  // ── Session lock & rollback ──

  private acquireSession(): Promise<void> | undefined {
    return this.sessionLock?.acquire(this.duplexId);
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
