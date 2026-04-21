/**
 * Pool factory — creates a pg.Pool backed by a caller-supplied PGlite instance.
 *
 * Each pool connection gets its own PGliteBridge stream, all sharing the
 * same PGlite WASM instance and SessionLock. The session lock ensures
 * transaction isolation: when one bridge starts a transaction (BEGIN),
 * it gets exclusive PGlite access until COMMIT/ROLLBACK. Non-transactional
 * operations from any bridge serialize through PGlite's runExclusive mutex.
 */
import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteBridge } from './pglite-bridge.ts';
import type { TelemetrySink } from './utils/adapter-stats.ts';
import { SessionLock } from './utils/session-lock.ts';

export interface CreatePoolOptions {
  /** PGlite instance to bridge to. The caller owns its lifecycle. */
  pglite: PGlite;

  /**
   * Maximum pool connections (default: 1).
   *
   * PGlite's WASM runtime executes queries serially, so multiple pool
   * connections add memory overhead without enabling parallelism. The
   * default of 1 matches that reality and minimises RSS.
   */
  max?: number;

  /**
   * Identity tag published with every diagnostics-channel event. Subscribers
   * filter on this to distinguish events from different adapters in the
   * same process. A fresh `Symbol('adapter')` is generated if omitted.
   */
  adapterId?: symbol;

  telemetry?: TelemetrySink;
}

export interface PoolResult {
  /** pg.Pool backed by PGlite — pass to PrismaPg */
  pool: pg.Pool;

  /**
   * Identity tag carried on every `QUERY_CHANNEL` / `LOCK_WAIT_CHANNEL`
   * event this pool produces. Matches the `adapterId` option if supplied,
   * otherwise a freshly minted symbol. Filter on it from external
   * subscribers to isolate this pool's events.
   */
  adapterId: symbol;

  /** Shut down the pool. Does not close the caller-owned PGlite instance. */
  close: () => Promise<void>;
}

/**
 * Creates a pg.Pool where every connection is an in-process PGlite bridge.
 *
 * Most users should prefer {@link createPgliteAdapter}, which wraps this
 * function and also handles schema application and reset/snapshot lifecycle.
 *
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { createPool } from 'prisma-pglite-bridge';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * const { pool, close } = await createPool({ pglite });
 * const adapter = new PrismaPg(pool);
 * const prisma = new PrismaClient({ adapter });
 * ```
 *
 * @see {@link createPgliteAdapter} for the higher-level API with schema management.
 */
export const createPool = async (options: CreatePoolOptions): Promise<PoolResult> => {
  const { pglite, max = 1, telemetry } = options;
  const adapterId = options.adapterId ?? Symbol('adapter');

  await pglite.waitReady;

  const sessionLock = new SessionLock();

  // Subclass pg.Client to inject PGliteBridge as the stream
  const Client = class extends pg.Client {
    constructor(config?: string | pg.ClientConfig) {
      const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
      super({
        ...cfg,
        user: 'postgres',
        database: 'postgres',
        stream: () => new PGliteBridge(pglite, sessionLock, adapterId, telemetry),
      });
    }
  };

  const pool = new pg.Pool({ Client, max });
  const close = () => pool.end();

  return { pool, adapterId, close };
};
