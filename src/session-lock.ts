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

export const createBridgeId = (): BridgeId => Symbol('bridge');

/**
 * Extracts the ReadyForQuery status byte from a response buffer.
 * Scans from the end since RFQ is always the last message.
 * Returns null if no RFQ found.
 */
export const extractRfqStatus = (response: Uint8Array): number | null => {
  // RFQ is always 6 bytes: Z(5a) + length(00000005) + status
  // It's the last message in the response
  if (response.length < 6) return null;
  const i = response.length - 6;
  if (
    response[i] === 0x5a &&
    response[i + 1] === 0x00 &&
    response[i + 2] === 0x00 &&
    response[i + 3] === 0x00 &&
    response[i + 4] === 0x05
  ) {
    return response[i + 5] ?? null;
  }
  return null;
};

export class SessionLock {
  private owner: BridgeId | null = null;
  private waitQueue: Array<{ id: BridgeId; resolve: () => void }> = [];

  /**
   * Acquire access to PGlite. Resolves immediately if no transaction is
   * active or if this bridge owns the current transaction. Queues otherwise.
   */
  async acquire(id: BridgeId): Promise<void> {
    if (this.owner === null || this.owner === id) return;

    // Another bridge owns the session (in a transaction) — wait
    return new Promise<void>((resolve) => {
      this.waitQueue.push({ id, resolve });
    });
  }

  /**
   * Update session state based on the ReadyForQuery status byte.
   * Call after every PGlite response that contains RFQ.
   */
  updateStatus(id: BridgeId, status: number): void {
    if (status === STATUS_IN_TRANSACTION || status === STATUS_FAILED) {
      // This bridge now owns the session
      this.owner = id;
    } else if (status === STATUS_IDLE) {
      // Transaction complete — release ownership
      if (this.owner === id) {
        this.owner = null;
        this.drainWaitQueue();
      }
    }
  }

  /**
   * Release ownership (e.g., when a bridge is destroyed mid-transaction).
   */
  release(id: BridgeId): void {
    if (this.owner === id) {
      this.owner = null;
      this.drainWaitQueue();
    }
  }

  private drainWaitQueue(): void {
    // Wake all waiting bridges — they'll serialize through runExclusive
    const waiters = this.waitQueue;
    this.waitQueue = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }
}
