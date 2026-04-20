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
import type { TelemetrySink } from './adapter-stats.ts';
import { PGliteBridge } from './pglite-bridge.ts';
import { SessionLock } from './session-lock.ts';

const { Client, Pool } = pg;

const nsToMs = (ns: bigint): number => Number(ns) / 1_000_000;

export interface CreatePoolOptions {
  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

  /** PGlite extensions (e.g., `{ uuid_ossp: uuidOssp() }`) */
  extensions?: Extensions;

  /**
   * Maximum pool connections (default: 1).
   *
   * PGlite's WASM runtime executes queries serially, so multiple pool
   * connections add memory overhead without enabling parallelism. The
   * default of 1 matches that reality and minimises RSS.
   */
  max?: number;

  /** Existing PGlite instance to use instead of creating one */
  pglite?: PGlite;

  /**
   * Identity tag published with every diagnostics-channel event. Subscribers
   * filter on this to distinguish events from different adapters in the
   * same process. A fresh `Symbol('adapter')` is generated if omitted.
   */
  adapterId?: symbol;
}

type CreateBridgePoolOptions = CreatePoolOptions & {
  telemetry?: TelemetrySink;
};

export interface PoolResult {
  /** pg.Pool backed by PGlite — pass to PrismaPg */
  pool: pg.Pool;

  /** The underlying PGlite instance */
  pglite: PGlite;

  /**
   * Identity tag carried on every `QUERY_CHANNEL` / `LOCK_WAIT_CHANNEL`
   * event this pool produces. Matches the `adapterId` option if supplied,
   * otherwise a freshly minted symbol. Filter on it from external
   * subscribers to isolate this pool's events.
   */
  adapterId: symbol;

  /**
   * Milliseconds spent constructing and awaiting PGlite's `waitReady`.
   * Defined only when the pool constructed the PGlite instance itself —
   * `undefined` when the caller supplied `options.pglite`, since the
   * caller owns that timing.
   */
  wasmInitMs?: number;

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
const createBridgePool = async (options: CreateBridgePoolOptions = {}): Promise<PoolResult> => {
  const { dataDir, extensions, max = 1 } = options;
  const adapterId = options.adapterId ?? Symbol('adapter');
  const ownsInstance = !options.pglite;
  const { telemetry } = options;

  let pglite: PGlite;
  let wasmInitMs: number | undefined;
  if (options.pglite) {
    pglite = options.pglite;
    await pglite.waitReady;
  } else {
    const wasmStart = process.hrtime.bigint();
    pglite = new PGlite(dataDir, extensions ? { extensions } : undefined);
    await pglite.waitReady;
    wasmInitMs = nsToMs(process.hrtime.bigint() - wasmStart);
  }

  const sessionLock = new SessionLock();

  // Subclass pg.Client to inject PGliteBridge as the stream
  const BridgedClient = class extends Client {
    constructor(config?: string | pg.ClientConfig) {
      const cfg = typeof config === 'string' ? { connectionString: config } : (config ?? {});
      super({
        ...cfg,
        user: 'postgres',
        database: 'postgres',
        stream: (() =>
          new PGliteBridge(pglite, sessionLock, adapterId, telemetry)) as pg.ClientConfig['stream'],
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

  return { pool, pglite, adapterId, wasmInitMs, close };
};

export const createPool = async (options: CreatePoolOptions = {}): Promise<PoolResult> =>
  createBridgePool(options);

/** @internal Adapter-owned stats wiring for bridge-backed pools. */
export const createPoolWithTelemetry = async (
  options: CreateBridgePoolOptions = {},
): Promise<PoolResult> => createBridgePool(options);
