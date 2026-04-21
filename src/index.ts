/**
 * prisma-pglite-bridge — in-process PGlite bridge for Prisma.
 *
 * @example
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { createPgliteAdapter } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * const { adapter, resetDb } = await createPgliteAdapter({
 *   pglite,
 *   migrationsPath: './prisma/migrations',
 * });
 * const prisma = new PrismaClient({ adapter });
 * ```
 *
 * @packageDocumentation
 */

// ── High-level API (most users only need this) ──
export type {
  CreatePgliteAdapterOptions,
  PgliteAdapter,
  ResetDbFn,
  ResetSnapshotFn,
  SnapshotDbFn,
  StatsFn,
} from './create-pglite-adapter.ts';
export { createPgliteAdapter } from './create-pglite-adapter.ts';

// ── Low-level building blocks ──
import {
  type CreatePoolOptions as CreateBasePoolOptions,
  createPool as createBasePool,
  type PoolResult,
} from './create-pool.ts';

export type { PoolResult };

/**
 * Options for {@link createPool}. Identical to the internal pool options,
 * minus the library-private `telemetry` sink (consumers subscribe via
 * `node:diagnostics_channel` instead — see {@link QUERY_CHANNEL} and
 * {@link LOCK_WAIT_CHANNEL}).
 */
export type CreatePoolOptions = Omit<CreateBasePoolOptions, 'telemetry'>;

/**
 * Build a `pg.Pool` backed by a caller-supplied PGlite instance. Each pool
 * connection bridges through its own {@link PGliteBridge} stream while
 * sharing one PGlite WASM runtime and session lock.
 *
 * Use this low-level entry point when you want a raw `pg.Pool` (for example
 * to wire into `@prisma/adapter-pg` yourself). Most users should prefer
 * {@link createPgliteAdapter}, which layers schema setup and reset helpers
 * on top.
 */
export const createPool = async (options: CreatePoolOptions): Promise<PoolResult> =>
  createBasePool(options);
export { PGliteBridge } from './pglite-bridge.ts';
export type { Stats, StatsBasic, StatsFull, StatsLevel } from './utils/adapter-stats.ts';
// ── Diagnostics channels (public observability surface) ──
export {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './utils/diagnostics.ts';
export { SessionLock } from './utils/session-lock.ts';
