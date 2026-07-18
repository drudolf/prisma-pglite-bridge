import type pg from 'pg';
import { PgBridgeError } from '../errors.ts';

/**
 * Throw `POOL_NOT_IDLE` unless the pool has zero in-flight or waiting
 * checkouts. Shared by `PGliteBridge` and the pool testing context — both
 * run raw SQL directly against the PGlite instance, bypassing the pool's
 * `SessionLock`, so concurrent pool traffic would interleave unsafely.
 *
 * waitingCount covers the same-tick window: pg-pool defers dispatch of a
 * queued checkout by one tick, so an un-awaited query/connect fired in
 * the calling tick is a waiter, not yet a checkout — invisible to
 * totalCount - idleCount. A query behind a caller-side async hop is
 * invisible to EVERY pool counter; "await all queries first" remains the
 * contract, this guard just converts the observable misuse into a throw.
 *
 * @param advice  The caller-audience second sentence of the message —
 *   Prisma-flavored for `PGliteBridge`, driver-neutral for the pool
 *   testing context. Existing `PGliteBridge` messages stay byte-identical.
 */
export const assertPoolIdle = (pool: pg.Pool, method: string, advice: string): void => {
  const busy = pool.totalCount - pool.idleCount + pool.waitingCount;
  if (busy > 0) {
    throw new PgBridgeError(
      'POOL_NOT_IDLE',
      `${method}() requires no in-flight or waiting pool checkouts; got ${busy}. ${advice}`,
    );
  }
};
