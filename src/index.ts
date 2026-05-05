/**
 * prisma-pglite-bridge — in-process PGlite bridge for Prisma.
 *
 * @example
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
 *
 * const bridge = new PGliteBridge({ pglite });
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * ```
 *
 * @packageDocumentation
 */

export { PGliteDuplex, type PGliteDuplexOptions } from './duplex';
export { PGliteBridge, type PGliteBridgeConfig } from './pglite-bridge';
export type { PGliteServerOptions } from './pglite-server';
export { PGliteServer } from './pglite-server';
export { PgBridgePool, type PgBridgePoolConfig } from './pool';
export type { PushSchemaOptions, PushSchemaResult } from './schema';
export { pushSchema, resetSchema } from './schema';
export type { PushMigrationsOptions, PushMigrationsResult } from './schema/migrations.ts';
export { hasMigrations, hasSchema, pushMigrations } from './schema/migrations.ts';
export type { Stats, StatsBasic, StatsFull, StatsLevel } from './telemetry/bridge-stats.ts';
export {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './telemetry/diagnostics.ts';
export type { SyncToFsMode } from './utils/resolve-sync-to-fs.ts';
export { SessionLock } from './utils/session-lock.ts';
