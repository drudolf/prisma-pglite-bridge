/**
 * Session-level lock for PGlite's single-session model.
 *
 * PGlite runs PostgreSQL in single-user mode — one session shared by all
 * bridges. runExclusive serializes individual operations, but transactions
 * span multiple operations. Without session-level locking, Bridge A's BEGIN
 * and Bridge B's query interleave, corrupting transaction boundaries.
 *
 * The session lock tracks which bridge owns the session. When PGlite enters
 * transaction state (ReadyForQuery status 'T' or 'E'), the owning bridge
 * gets exclusive access until the transaction completes (status returns to 'I').
 *
 * Non-transactional operations from any bridge are allowed when no transaction
 * is active — they serialize naturally through runExclusive.
 */

// ReadyForQuery status bytes
const STATUS_IDLE = 0x49; // 'I' — no transaction
const STATUS_IN_TRANSACTION = 0x54; // 'T' — in transaction block
const STATUS_FAILED = 0x45; // 'E' — failed transaction block

/** Opaque bridge identity token */
export type BridgeId = symbol;

/**
 * Coordinates PGlite access across concurrent pool connections.
 *
 * @remarks
 * PGlite runs PostgreSQL in single-user mode — one session shared by all
 * bridges. The session lock tracks which bridge owns the session during
 * transactions, preventing interleaving. Used internally by {@link PGliteBridge}
 * and created automatically by {@link createPool}. Only instantiate directly
 * if building a custom pool setup.
 */
export class SessionLock {
  private owner?: BridgeId;
  private waitQueue: Array<{ id: BridgeId; resolve: () => void; reject: (error: Error) => void }> =
    [];

  /**
   * Acquire access to PGlite. Resolves immediately if no transaction is
   * active or if this bridge owns the current transaction. Queues otherwise.
   */
  async acquire(id: BridgeId): Promise<void> {
    // Free slot or re-entrant — pass through
    if (this.owner === undefined || this.owner === id) return;

    // Another bridge owns the session — wait
    return new Promise<void>((resolve, reject) => {
      this.waitQueue.push({
        id,
        resolve,
        reject,
      });
    });
  }

  /**
   * Update session state based on the ReadyForQuery status byte.
   * Call after every PGlite response that contains RFQ.
   *
   * @returns `true` if ownership transitioned on this call (acquired or
   *   released). `false` for no-op updates (e.g., re-entrant status within
   *   the same transaction, or IDLE from a non-owning bridge).
   */
  updateStatus(id: BridgeId, status: number): boolean {
    if (status === STATUS_IN_TRANSACTION || status === STATUS_FAILED) {
      if (this.owner === id) return false;
      this.owner = id;
      return true;
    }

    // Transaction complete — release ownership
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
  release(id: BridgeId): boolean {
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
  cancel(id: BridgeId, error: Error = new Error('Session lock acquire cancelled')): boolean {
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

  /**
   * Grant ownership to the next waiter, if any.
   *
   * @returns `true` if a waiter was unblocked; `false` if the queue was empty.
   */
  private drainWaitQueue(): boolean {
    // Release one waiter at a time and grant ownership before resolving.
    // The waiter's operation will call updateStatus when it completes —
    // if IDLE, ownership is cleared and the next waiter is released.
    // This prevents interleaving where multiple waiters race past acquire
    // and one starts a transaction while others proceed unserialized.
    const next = this.waitQueue.shift();
    if (!next) return false;

    this.owner = next.id;
    next.resolve();
    return true;
  }
}
