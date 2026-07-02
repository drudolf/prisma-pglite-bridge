/**
 * `PgBridgePool` — a `pg.Pool` subclass backed by a PGlite instance.
 *
 * Each pool connection gets its own PGliteDuplex stream, all sharing the
 * same PGlite WASM instance. Pools with multiple connections also share a
 * SessionLock. The session lock ensures transaction isolation: when one
 * bridge starts a transaction (BEGIN), it gets exclusive PGlite access until
 * COMMIT/ROLLBACK. Non-transactional operations from any bridge serialize
 * through PGlite's runExclusive mutex.
 */
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import { pgliteNeedsProtocolCleanup } from '../utils/pglite-capabilities.ts';
import { resolveSyncToFs, type SyncToFsMode } from '../utils/resolve-sync-to-fs.ts';
import { SessionLock } from '../utils/session-lock.ts';
import { PgBridgeClient, type PgBridgeClientOptions } from './pg-bridge-client.ts';

export interface PgBridgePoolOptions
  extends Omit<PgBridgeClientOptions, 'pglite' | 'bridgeId' | 'syncToFs' | 'telemetry'> {
  /**
   * PGlite instance to back the pool. When omitted the pool creates its own
   * in-memory `PGlite` and owns its lifecycle — `end()` shuts it down. When
   * provided the caller owns the lifecycle — `end()` leaves it open.
   */
  pglite?: PGlite | PGliteInterface;

  /**
   * Identity tag published with every diagnostics-channel event. Subscribers
   * filter on this to distinguish events from different bridges in the
   * same process. A fresh `Symbol('bridge')` is generated if omitted; the
   * same `symbol` reference is reused on every event from this pool.
   * Hold a reference if you need to filter from outside.
   */
  bridgeId?: symbol;

  /**
   * Maximum pool connections (default: 1). Compatibility knob, not a
   * throughput knob.
   *
   * PGlite's WASM runtime executes queries serially behind a single mutex.
   * Raising `max` above 1 therefore does not add parallelism — queries still
   * run one at a time — and each extra connection costs a full `PGliteDuplex`
   * (its framers and scratch buffers) plus shared session-lock coordination
   * in memory. Leave this at `1` unless your code specifically needs to check
   * out multiple `pg` clients or you are deliberately exercising wait-queue
   * behaviour in a test.
   */
  max?: number;

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

  /**
   * Maximum milliseconds to wait for the PGlite instance to become ready
   * before each bridge operation. Defaults to no timeout (waits indefinitely).
   */
  timeout?: number;
}

/**
 * A pg.Pool where every connection is an in-process PGlite bridge.
 *
 * **Ownership:** when no `pglite` is supplied the pool creates its own
 * in-memory `PGlite` and owns it — `end()` shuts it down. When you supply
 * a `pglite`, the pool treats it as caller-owned and `end()` leaves it open.
 *
 * Most users should prefer {@link PGliteBridge}, which wraps this class and
 * also handles schema application and reset/snapshot lifecycle.
 *
 * ```typescript
 * import { PgBridgePool } from 'prisma-pglite-bridge';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from '@prisma/client';
 *
 * // Pool creates and owns its own in-memory PGlite:
 * const pool = new PgBridgePool();
 * const adapter = new PrismaPg(pool);
 * const prisma = new PrismaClient({ adapter });
 * await prisma.$disconnect();
 * await pool.end(); // closes pool + pglite (pool owns it)
 *
 * // Caller-supplied PGlite — caller owns the lifecycle:
 * import { PGlite } from '@electric-sql/pglite';
 * const pglite = new PGlite();
 * const pool = new PgBridgePool({ pglite });
 * await pool.end(); // closes pool only; pglite stays open
 * await pglite.close(); // caller is responsible
 * ```
 *
 * @see {@link PGliteBridge} for the higher-level API with schema management
 *   and reset/snapshot lifecycle.
 */
export class PgBridgePool extends pg.Pool {
  /**
   * Identity tag published on every diagnostics-channel event from this
   * pool. Stable for the lifetime of the pool — the same `symbol`
   * reference appears on every event.
   */
  readonly bridgeId: symbol;

  /**
   * The PGlite instance this pool wraps. Created internally when no `pglite`
   * option was supplied; otherwise the caller-supplied instance.
   */
  readonly pglite: PGlite | PGliteInterface;

  readonly #ownsPglite: boolean;

  constructor({
    bridgeId = Symbol('bridge'),
    max = 1,
    pglite,
    telemetry,
    timeout,
    syncToFs,
  }: PgBridgePoolOptions & { telemetry?: TelemetrySink } = {}) {
    const resolvedPglite = pglite ?? new PGlite();

    // Load-bearing: pg.Pool forwards this config object verbatim to
    // `new Client(config)`, including the symbol-keyed property below.
    // PgBridgeClient reads its bridge options from the same symbol.
    const poolConfig = {
      Client: PgBridgeClient,
      max,
      [PgBridgeClient.OptionsKey]: {
        pglite: resolvedPglite,
        sessionLock: max > 1 ? new SessionLock() : undefined,
        bridgeId,
        telemetry,
        syncToFs: resolveSyncToFs(resolvedPglite, syncToFs),
        timeout,
        protocolCleanupNeeded: pgliteNeedsProtocolCleanup(),
      },
    };

    super(poolConfig);

    this.bridgeId = bridgeId;
    this.pglite = resolvedPglite;
    this.#ownsPglite = !pglite;

    // A fresh connection must see an empty prepared-statement namespace,
    // as it would on a real server. PGlite is one shared session, so
    // statements prepared through an earlier (since destroyed) client
    // would otherwise collide with a new client re-preparing the same
    // names (42P05 "prepared statement already exists"). pg serializes
    // queries per client, so this runs before the client's first query.
    this.on('connect', (client) => {
      void client.query('DEALLOCATE ALL').catch(() => {
        // Best-effort: a broken session surfaces errors on real queries.
      });
    });
  }

  /**
   * Drain the pool and close all connections. When the pool created its own
   * PGlite (no `pglite` option at construction), also closes that instance.
   * When the caller supplied a `pglite`, it is left open.
   */
  override end(): Promise<void>;
  override end(callback: () => void): void;
  override end(callback?: () => void): Promise<void> | void {
    const cleanup = async (): Promise<void> => {
      if (this.#ownsPglite && !this.pglite.closed) {
        await this.pglite.close();
      }
    };
    if (callback) {
      super.end(() => {
        cleanup().then(callback, callback);
      });
      return;
    }
    return super.end().then(cleanup);
  }
}
