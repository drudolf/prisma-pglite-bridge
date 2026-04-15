/**
 * Pool factory — creates a pg.Pool backed by an in-process PGlite instance.
 *
 * Each pool connection gets its own PGliteBridge stream, all sharing the
 * same PGlite WASM instance and SessionLock. The session lock ensures
 * transaction isolation: when one bridge starts a transaction (BEGIN),
 * it gets exclusive PGlite access until COMMIT/ROLLBACK. Non-transactional
 * operations from any bridge serialize through PGlite's runExclusive mutex.
 */
import { type Extensions, PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteBridge } from './pglite-bridge.ts';
import { SessionLock } from './session-lock.ts';

const { Client, Pool } = pg;

export interface CreatePoolOptions {
  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

  /** PGlite extensions (e.g., `{ uuid_ossp: uuidOssp() }`) */
  extensions?: Extensions;

  /** Maximum pool connections (default: 5) */
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
 * Most users should prefer {@link createPgliteAdapter}, which wraps this
 * function and also handles schema application and reset/snapshot lifecycle.
 *
 * ```typescript
 * import { createPool } from 'prisma-pglite-bridge';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from '@prisma/client';
 *
 * const { pool, close } = await createPool();
 * const adapter = new PrismaPg(pool);
 * const prisma = new PrismaClient({ adapter });
 * ```
 *
 * @see {@link createPgliteAdapter} for the higher-level API with schema management.
 */
export const createPool = async (options: CreatePoolOptions = {}): Promise<PoolResult> => {
  const { dataDir, extensions, max = 5 } = options;
  const ownsInstance = !options.pglite;

  const pglite = options.pglite ?? new PGlite(dataDir, extensions ? { extensions } : undefined);
  await pglite.waitReady;

  const sessionLock = new SessionLock();

  // Subclass pg.Client to inject PGliteBridge as the stream
  const BridgedClient = class extends Client {
    constructor(config?: string | pg.ClientConfig) {
      const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
      super({
        ...cfg,
        user: 'postgres',
        database: 'postgres',
        stream: (() => new PGliteBridge(pglite, sessionLock)) as pg.ClientConfig['stream'],
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
