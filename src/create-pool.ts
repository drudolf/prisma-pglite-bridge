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

export type SyncToFsMode = 'auto' | boolean;

const resolveSyncToFs = (pglite: PGlite, mode: SyncToFsMode | undefined): boolean => {
  if (mode === true || mode === false) return mode;

  const dataDir = pglite.dataDir;
  return !(dataDir === undefined || dataDir === '' || dataDir.startsWith('memory://'));
};

export interface CreatePoolOptions {
  /** PGlite instance to bridge to. The caller owns its lifecycle. */
  pglite: PGlite;

  /**
   * Maximum pool connections (default: 1).
   *
   * PGlite's WASM runtime executes queries serially behind a single mutex,
   * and every bridge connection shares the same {@link SessionLock}. Raising
   * `max` above 1 therefore does not add parallelism — queries still run
   * one at a time — and each extra connection costs a full `PGliteBridge`
   * (its framers and scratch buffers) in memory. Leave this at `1` unless
   * you are deliberately exercising wait-queue behaviour in a test.
   */
  max?: number;

  /**
   * Identity tag published with every diagnostics-channel event. Subscribers
   * filter on this to distinguish events from different adapters in the
   * same process. A fresh `Symbol('adapter')` is generated if omitted.
   */
  adapterId?: symbol;

  /**
   * Filesystem sync policy for bridge-driven wire-protocol calls.
   *
   * - `'auto'` (default): disable per-query sync for clearly in-memory PGlite
   *   instances, keep it enabled otherwise.
   * - `true`: always sync before the bridge returns a query result.
   * - `false`: never sync on bridge protocol calls; fastest, but weaker durability.
   *
   * `auto` uses `pglite.dataDir` as a heuristic. If you provide a custom
   * persistent `fs` without a meaningful `dataDir`, pass `true` explicitly.
   */
  syncToFs?: SyncToFsMode;

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
  const syncToFs = resolveSyncToFs(pglite, options.syncToFs);

  await pglite.waitReady;

  const sessionLock = new SessionLock();

  // Subclass pg.Client to inject PGliteBridge as the stream
  const Client = class extends pg.Client {
    constructor(config: pg.ClientConfig = {}) {
      super({
        ...config,
        user: 'postgres',
        database: 'postgres',
        stream: () => new PGliteBridge(pglite, sessionLock, adapterId, telemetry, syncToFs),
      });
    }
  };

  const pool = new pg.Pool({ Client, max });
  const close = () => pool.end();

  return { pool, adapterId, close };
};
