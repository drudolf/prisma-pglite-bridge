/**
 * Pool factory — creates a pg.Pool backed by an in-process PGlite instance.
 *
 * Each pool connection gets its own PGliteBridge stream, all sharing the
 * same PGlite WASM instance. PGlite's runExclusive mutex serializes access.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteBridge } from './bridge.ts';

const { Client, Pool } = pg;

export interface CreatePoolOptions {
  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

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
 * ```typescript
 * import { createPool } from 'prisma-enlite';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from '@prisma/client';
 *
 * const { pool, close } = await createPool();
 * const adapter = new PrismaPg({ pool });
 * const prisma = new PrismaClient({ adapter });
 * ```
 */
export const createPool = async (options: CreatePoolOptions = {}): Promise<PoolResult> => {
  const { dataDir, max = 5 } = options;
  const ownsInstance = !options.pglite;

  const pglite = options.pglite ?? new PGlite(dataDir);
  await pglite.waitReady;

  // Subclass pg.Client to inject PGliteBridge as the stream
  const pgliteRef = pglite;
  const BridgedClient = class extends Client {
    constructor(config?: string | pg.ClientConfig) {
      const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
      super({
        ...cfg,
        user: 'postgres',
        database: 'postgres',
        // pg.Client accepts `stream` to replace TCP — undocumented but stable
        // Types expect a factory function, but pg also accepts a stream instance
        stream: (() => new PGliteBridge(pgliteRef)) as pg.ClientConfig['stream'],
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
