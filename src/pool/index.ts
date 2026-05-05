/**
 * `PgBridgePool` — a `pg.Pool` subclass backed by a caller-supplied PGlite instance.
 *
 * Each pool connection gets its own PGliteDuplex stream, all sharing the
 * same PGlite WASM instance. Pools with multiple connections also share a
 * SessionLock. The session lock ensures transaction isolation: when one
 * bridge starts a transaction (BEGIN), it gets exclusive PGlite access until
 * COMMIT/ROLLBACK. Non-transactional operations from any bridge serialize
 * through PGlite's runExclusive mutex.
 */
import pg from 'pg';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import { resolveSyncToFs, type SyncToFsMode } from '../utils/resolve-sync-to-fs.ts';
import { SessionLock } from '../utils/session-lock.ts';
import { PgBridgeClient, type PgBridgeClientOptions } from './pg-bridge-client.ts';

export interface PgBridgePoolConfig
  extends Omit<PgBridgeClientOptions, 'bridgeId' | 'syncToFs' | 'telemetry'> {
  /**
   * Identity tag published with every diagnostics-channel event. Subscribers
   * filter on this to distinguish events from different bridges in the
   * same process. A fresh `Symbol('bridge')` is generated if omitted.
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
 * Most users should prefer {@link PGliteBridge}, which wraps this class and
 * also handles schema application and reset/snapshot lifecycle.
 *
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { PgBridgePool } from 'prisma-pglite-bridge';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pool = new PgBridgePool({ pglite: new PGlite() });
 * const adapter = new PrismaPg(pool);
 * const prisma = new PrismaClient({ adapter });
 * ```
 *
 * @see {@link PGliteBridge} for the higher-level API with schema management.
 */
export class PgBridgePool extends pg.Pool {
  readonly bridgeId: symbol;

  constructor({
    bridgeId = Symbol('bridge'),
    max = 1,
    pglite,
    telemetry,
    timeout,
    syncToFs,
  }: PgBridgePoolConfig & { telemetry?: TelemetrySink }) {
    // Load-bearing: pg.Pool forwards this config object verbatim to
    // `new Client(config)`, including the symbol-keyed property below.
    // PgBridgeClient reads its bridge options from the same symbol.
    const poolConfig = {
      Client: PgBridgeClient,
      max,
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock: max > 1 ? new SessionLock() : undefined,
        bridgeId,
        telemetry,
        syncToFs: resolveSyncToFs(pglite, syncToFs),
        timeout,
      },
    };

    super(poolConfig);

    this.bridgeId = bridgeId;
  }
}
