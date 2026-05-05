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

export { PGliteDuplex } from './duplex';
export type { PushMigrationsOptions, PushMigrationsResult } from './migrations.ts';
export { hasMigrations, hasSchema, pushMigrations } from './migrations.ts';
export { PGliteBridge, type PGliteBridgeConfig } from './pglite-bridge/index.ts';
export type { PGliteServerOptions } from './pglite-server.ts';
export { PGliteServer } from './pglite-server.ts';
export { PgBridgePool, type PgBridgePoolConfig } from './pool/index.ts';
export type { PushSchemaOptions, PushSchemaResult } from './schema.ts';
export { pushSchema, resetSchema } from './schema.ts';
export type { Stats, StatsBasic, StatsFull, StatsLevel } from './telemetry/bridge-stats.ts';
export {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './telemetry/diagnostics.ts';
export type { SyncToFsMode } from './utils/resolve-sync-to-fs.ts';
export { SessionLock } from './utils/session-lock.ts';
