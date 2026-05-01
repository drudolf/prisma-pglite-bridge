/**
 * prisma-pglite-bridge — in-process PGlite bridge for Prisma.
 *
 * @example
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * const bridge = await createPGliteBridge({ pglite });
 * await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
 *
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * ```
 *
 * @packageDocumentation
 */

export type { PushMigrationsOptions, PushMigrationsResult } from './migrations.ts';
export { pushMigrations } from './migrations.ts';
// ── High-level API (most users only need this) ──
export type {
  CloseFn,
  PGliteBridge,
  PGliteBridgeOptions,
  ResetDbFn,
  ResetSnapshotFn,
  SnapshotDbFn,
  StatsFn,
} from './pglite-bridge.ts';
export { createPGliteBridge } from './pglite-bridge.ts';
export type { PushSchemaOptions, PushSchemaResult, SchemaTarget } from './schema.ts';
export { pushSchema, resetSchema } from './schema.ts';

// ── Low-level building blocks ──
import {
  type PoolOptions as BasePoolOptions,
  createPool as createBasePool,
  type PoolResult,
} from './pool.ts';

export type { PoolResult };

/**
 * Options for {@link createPool}. Identical to the internal pool options,
 * minus the library-private `telemetry` sink (consumers subscribe via
 * `node:diagnostics_channel` instead — see {@link QUERY_CHANNEL} and
 * {@link LOCK_WAIT_CHANNEL}).
 */
export type PoolOptions = Omit<BasePoolOptions, 'telemetry'>;
export type { SyncToFsMode } from './pool.ts';

/**
 * Build a `pg.Pool` backed by a caller-supplied PGlite instance. Each pool
 * connection bridges through its own {@link PGliteDuplex} stream while
 * sharing one PGlite WASM runtime and session lock.
 *
 * Use this low-level entry point when you want a raw `pg.Pool` (for example
 * to wire into `@prisma/adapter-pg` yourself). Most users should prefer
 * {@link createPGliteBridge}, which layers schema setup and reset helpers
 * on top.
 */
export const createPool = async (options: PoolOptions): Promise<PoolResult> =>
  createBasePool(options);
export { PGliteDuplex } from './duplex';
export type { PGliteServer, PGliteServerOptions } from './pglite-server.ts';
export { createPGliteServer } from './pglite-server.ts';
export type { Stats, StatsBasic, StatsFull, StatsLevel } from './utils/bridge-stats.ts';
// ── Diagnostics channels (public observability surface) ──
export {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './utils/diagnostics.ts';
export { SessionLock } from './utils/session-lock.ts';
