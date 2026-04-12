/**
 * Pool factory — creates a pg.Pool backed by an in-process PGlite instance.
 *
 * Each pool connection gets its own PGliteBridge stream, all sharing the
 * same PGlite WASM instance. PGlite's runExclusive mutex serializes access.
 *
 * IMPORTANT: PGlite is single-session — all pool connections share one
 * PostgreSQL session. SET variables, prepared statements, and transaction
 * state are global. The pool defaults to max=1 to prevent concurrent
 * connections from corrupting each other's transaction boundaries.
 * Increase max only if your workload is read-only or uses only Prisma's
 * managed interactive transactions (which hold a single connection).
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteBridge } from './pglite-bridge.ts';

const { Client, Pool } = pg;

export interface CreatePoolOptions {
  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

  /** Maximum pool connections (default: 1 — see createPool docs for why) */
  max?: number;

  /** Existing PGlite instance to use instead of creating one */
  pglite?: PGlite;
}

export interface PoolResult {
  /** pg.Pool backed by PGlite — pass to PrismaPg */
  pool: pg.Pool;

  /** The underlying PGlite instance */
  pglite: PGlite;

  /** Shut down pool and PGlite */
  close: () => Promise<void>;
}

/**
 * Creates a pg.Pool where every connection is an in-process PGlite bridge.
 *
 * ```typescript
 * import { createPool } from 'prisma-enlite';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from '@prisma/client';
 *
 * const { pool, close } = await createPool();
 * const adapter = new PrismaPg(pool);
 * const prisma = new PrismaClient({ adapter });
 * ```
 */
export const createPool = async (options: CreatePoolOptions = {}): Promise<PoolResult> => {
  const { dataDir, max = 1 } = options;
  const ownsInstance = !options.pglite;

  const pglite = options.pglite ?? new PGlite(dataDir);
  await pglite.waitReady;

  // Subclass pg.Client to inject PGliteBridge as the stream
  const BridgedClient = class extends Client {
    constructor(config?: string | pg.ClientConfig) {
      const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
      super({
        ...cfg,
        user: 'postgres',
        database: 'postgres',
        stream: (() => new PGliteBridge(pglite)) as pg.ClientConfig['stream'],
      });
    }
  };

  const pool = new Pool({
    Client: BridgedClient as typeof Client,
    max,
  });

  const close = async () => {
    await pool.end();
    if (ownsInstance) {
      await pglite.close();
    }
  };

  return { pool, pglite, close };
};
