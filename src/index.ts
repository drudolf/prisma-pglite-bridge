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
 * await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
 *
 * const bridge = await createPGliteBridge({ pglite });
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * ```
 *
 * @packageDocumentation
 */

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
export { PGliteDuplex } from './duplex';
export type { PushMigrationsOptions, PushMigrationsResult } from './migrations.ts';
export { hasMigrations, hasSchema, pushMigrations } from './migrations.ts';
// ── High-level API (most users only need this) ──
export { default as PGliteBridge, type PGliteBridgeConfig } from './pglite-bridge.ts';
export type { PGliteServerOptions } from './pglite-server.ts';
export { PGliteServer } from './pglite-server.ts';
// ── Low-level building blocks ──
export { default as PgBridgePool, type PgBridgePoolConfig } from './pool.ts';
export type { PushSchemaOptions, PushSchemaResult } from './schema.ts';
export { pushSchema, resetSchema } from './schema.ts';
export type { Stats, StatsBasic, StatsFull, StatsLevel } from './utils/bridge-stats.ts';
// ── Diagnostics channels (public observability surface) ──
export {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './utils/diagnostics.ts';
export type { SyncToFsMode } from './utils/resolve-sync-to-fs.ts';
export { SessionLock } from './utils/session-lock.ts';
