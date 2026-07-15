/**
 * Session-level lock for PGlite's single-session model.
 *
 * PGlite runs PostgreSQL in single-user mode — one session shared by all
 * bridges of a pool. runExclusive serializes individual operations, but
 * transactions span multiple operations. Without session-level locking,
 * Bridge A's BEGIN and Bridge B's query interleave, corrupting transaction
 * boundaries.
 *
 * Ownership model: ownership is acquired AT ADMISSION — `acquire` takes the
 * session before the first byte of an operation reaches PGlite — and is
 * released at the first ReadyForQuery `I` (idle) the owner observes, or by
 * explicit `release`/`cancel` on teardown paths. Response processing never
 * GRANTS ownership: `T`/`E` (in-transaction / failed) mean the owner keeps
 * the session across operations, so a transaction simply extends the hold
 * its BEGIN's admission took, and a suspended row-limited portal (which
 * emits no RFQ until Sync) keeps it the same way. Waiters queue FIFO and
 * are granted ownership one at a time.
 *
 * Operations from different bridges therefore serialize in ADMISSION order.
 * They were always serial in execution (runExclusive); reservation moves the
 * decision to admission so an operation can never execute inside a sibling's
 * transaction, and a sibling's ReadyForQuery can never "steal" the session
 * from its rightful owner (both probe-verified failure modes of the earlier
 * response-time ownership model).
 *
 * The guarantee is per pool (one lock per `max > 1` pool): raw PGlite
 * consumers and other pools sharing the instance are outside it — see the
 * shared-instance advisory.
 */

// ReadyForQuery status byte
const STATUS_IDLE = 0x49; // 'I' — no transaction

/**
 * Coordinates PGlite access across concurrent pool connections.
 *
 * @remarks
 * PGlite runs PostgreSQL in single-user mode — one session shared by all
 * bridges. Ownership is taken at `acquire` (admission) and released on the
 * owner's idle ReadyForQuery, preventing cross-bridge transaction
 * interleaving. Used internally by {@link PGliteDuplex} and created
 * automatically by {@link PgBridgePool}. Only instantiate directly if
 * building a custom pool setup.
 */
export class SessionLock {
  private owner?: symbol;
  private waitQueue: Array<{ id: symbol; resolve: () => void; reject: (error: Error) => void }> =
    [];

  /**
   * Acquire the session: TAKES ownership when the session is free, is
   * re-entrant for the current owner, and queues FIFO otherwise. A resolved
   * acquire IS the right to submit to PGlite — no operation may reach the
   * backend without it.
   *
   * Re-entrancy admits only the owner's NEXT operation, never a concurrent
   * one: the duplex's protocol calls are strictly sequential per duplex (the
   * single-flight drain loop awaits each call before consuming more input —
   * see the framer-state invariant in `PGliteDuplex`), and pg runs one
   * active query per connection.
   */
  async acquire(id: symbol): Promise<void> {
    if (this.owner === undefined) {
      this.owner = id;
      return;
    }
    if (this.owner === id) return;

    // Another bridge owns the session — wait
    return new Promise<void>((resolve, reject) => {
      this.waitQueue.push({
        id,
        resolve,
        reject,
      });
    });
  }

  /** Returns `true` if `id` currently holds the session (e.g., is mid-transaction). */
  isOwner(id: symbol): boolean {
    return this.owner === id;
  }

  /**
   * Take the session if free, without queueing.
   *
   * @deprecated Ownership has been acquired at admission (`acquire`) since
   * the admission-reservation fix, and the bridge no longer calls this. Kept
   * as a behavior-identical shim for custom multi-duplex setups that used
   * the portal-hold API; scheduled for removal in the next major.
   * @returns `true` if `id` now holds (or already held) the session.
   */
  hold(id: symbol): boolean {
    if (this.owner === undefined) {
      this.owner = id;
      return true;
    }
    return this.owner === id;
  }

  /**
   * Update session state from a ReadyForQuery status byte. Call after every
   * PGlite response that contains an RFQ.
   *
   * The ONLY mutation is release-on-idle by the current owner (which drains
   * the next FIFO waiter). Ownership is never granted here: a `T`/`E` is an
   * inert confirmation that the admission-acquired hold continues, and any
   * status from a non-owner — reachable only when a torn-down duplex's late
   * response frames after `cancel` cleared its claim — must neither steal
   * the session from a drained successor nor resurrect the cancelled claim.
   *
   * @returns `true` if ownership was released on this call.
   */
  updateStatus(id: symbol, status: number): boolean {
    if (status === STATUS_IDLE && this.owner === id) {
      this.owner = undefined;
      this.drainWaitQueue();
      return true;
    }

    return false;
  }

  /**
   * Release ownership (e.g., when a bridge is destroyed mid-transaction).
   *
   * @returns `true` if this bridge held ownership and released it. `false`
   *   if another bridge (or no one) owned the session.
   */
  release(id: symbol): boolean {
    if (this.owner === id) {
      this.owner = undefined;
      this.drainWaitQueue();
      return true;
    }

    return false;
  }

  /**
   * Cancel this bridge's pending or active claim on the session.
   *
   * Used when a bridge is torn down while blocked in `acquire()` so it cannot
   * later be granted ownership after destruction.
   */
  cancel(id: symbol, error: Error = new Error('Session lock acquire cancelled')): boolean {
    let cancelled = false;

    if (this.owner === id) {
      this.owner = undefined;
      this.drainWaitQueue();
      cancelled = true;
    }

    const remaining: typeof this.waitQueue = [];
    for (const waiter of this.waitQueue) {
      if (waiter.id === id) {
        waiter.reject(error);
        cancelled = true;
      } else {
        remaining.push(waiter);
      }
    }
    this.waitQueue = remaining;

    return cancelled;
  }

  /** Grant ownership to the next waiter, if any. */
  private drainWaitQueue(): void {
    // Release one waiter at a time and grant ownership before resolving.
    // The waiter's operation will call updateStatus when it completes —
    // if IDLE, ownership is cleared and the next waiter is released.
    // This prevents interleaving where multiple waiters race past acquire
    // and one starts a transaction while others proceed unserialized.
    const next = this.waitQueue.shift();
    if (!next) return;

    this.owner = next.id;
    next.resolve();
  }
}
