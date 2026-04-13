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

export type {
  CreatePgliteAdapterOptions,
  PgliteAdapter,
  ResetDbFn,
  ResetSnapshotFn,
  SnapshotDbFn,
} from './create-pglite-adapter.ts';
export { createPgliteAdapter } from './create-pglite-adapter.ts';
export type { CreatePoolOptions, PoolResult } from './create-pool.ts';
export { createPool } from './create-pool.ts';
export { PGliteBridge } from './pglite-bridge.ts';
