/**
 * prisma-pglite-bridge — in-process PGlite bridge for Prisma.
 *
 * @example
 * ```typescript
 * import { createPgliteAdapter } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const { adapter, resetDb } = await createPgliteAdapter();
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
export type { CreatePoolOptions, PoolResult } from './create-pool.ts';
export { createPool } from './create-pool.ts';
export { PGliteBridge } from './pglite-bridge.ts';
export type { Stats, StatsLevel } from './utils/adapter-stats.ts';
// ── Diagnostics channels (public observability surface) ──
export {
  LOCK_WAIT_CHANNEL,
  type LockWaitEvent,
  QUERY_CHANNEL,
  type QueryEvent,
} from './utils/diagnostics.ts';
export { SessionLock } from './utils/session-lock.ts';
