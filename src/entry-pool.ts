/**
 * prisma-pglite-bridge/pool — the Prisma-free subpath entry.
 *
 * Re-exports the exact subset of the root barrel whose module graph never
 * imports `@prisma/*`: the pool, the duplex, typed errors, the session
 * lock, and the diagnostics channels. ORM users (drizzle, kysely, knex,
 * typeorm, mikro-orm) import from here so that constructing a
 * {@link PgBridgePool} never loads Prisma code — the CI purity gate
 * (`pnpm check:pool-purity`) enforces this on every build.
 *
 * The same symbols remain available from the root entry; both entries
 * share one module instance, so class identity (`instanceof`) is
 * unaffected by which entry a file imports from.
 *
 * @example
 * ```typescript
 * import { PgBridgePool } from 'prisma-pglite-bridge/pool';
 * import { Kysely, PostgresDialect } from 'kysely';
 *
 * const pool = new PgBridgePool();
 * const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
 * ```
 *
 * @packageDocumentation
 */

export { PGliteDuplex, type PGliteDuplexOptions } from './duplex';
export { PgBridgeError, type PgBridgeErrorCode } from './errors.ts';
export { PgBridgePool, type PgBridgePoolOptions } from './pool';
export type {
  QueryTrailEntry,
  QueryTrailError,
  QueryTrailHandle,
  QueryTrailKind,
  QueryTrailMeta,
  QueryTrailOptions,
} from './pool/query-trail.ts';
export {
  type FormatQueryTrailOptions,
  formatQueryTrail,
  TRAIL_FORMAT_VERSION,
} from './pool/query-trail-format.ts';
export type { Stats, StatsBasic, StatsFull, StatsLevel } from './telemetry/bridge-stats.ts';
export {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './telemetry/diagnostics.ts';
export type { SyncToFsMode } from './utils/resolve-sync-to-fs.ts';
export { SessionLock } from './utils/session-lock.ts';
