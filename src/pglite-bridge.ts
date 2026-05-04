/**
 * Prototype: class-based PGliteBridge with a synchronous constructor.
 *
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { PGliteBridge } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * const bridge = new PGliteBridge({ pglite });
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * ```
 *
 * Public methods are arrow-function class fields so destructuring stays safe:
 * `const { resetDb } = bridge; await resetDb();` works as expected.
 */
import type { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';

import PgBridgePool from './pool.ts';
import { BridgeStats, type Stats, type StatsLevel } from './utils/bridge-stats.ts';
import type { SyncToFsMode } from './utils/resolve-sync-to-fs.ts';
import { createSnapshotManager, type SnapshotManager } from './utils/snapshot.ts';

/** @internal Exported for testing. */
export const emitBridgeLeakWarning = (): void => {
  process.emitWarning(
    'PGliteBridge was garbage-collected before close() was called. ' +
      'Call bridge.close() to release the pool and finalize stats().',
    { type: 'PGliteBridgeLeakWarning' },
  );
};

const leakRegistry = new FinalizationRegistry<void>(emitBridgeLeakWarning);

export interface PGliteBridgeConfig {
  /**
   * Identity tag published with every diagnostics-channel event. Subscribers
   * filter on this to distinguish events from different bridges in the
   * same process. A fresh `Symbol('bridge')` is generated if omitted.
   */
  bridgeId?: symbol;

  /**
   * PGlite instance to bridge to. The caller owns its lifecycle — `close()`
   * shuts down the pool only, not the PGlite instance.
   */
  pglite: PGlite;

  /**
   * Maximum pool connections (default: 1). Compatibility knob, not a
   * throughput knob.
   *
   * PGlite serialises queries inside its WASM runtime. Extra pool connections
   * do not add parallelism; they only add bridge/client memory and
   * session-lock coordination. Leave this at `1` unless the code under test
   * specifically needs multiple checked-out `pg` clients.
   */
  max?: number;

  /**
   * Collect bridge/query telemetry. Default `'off'` (zero overhead).
   *
   * - `'basic'` — timing (`durationMs`, query percentiles) and counters
   *   (`queryCount`, `failedQueryCount`, `resetDbCalls`), plus
   *   `dbSizeBytes`.
   * - `'full'` — everything in `'basic'`, plus `processRssPeakBytes`
   *   (process-wide, sampled) and session-lock wait statistics.
   *
   * Retrieve via `await bridge.stats()` — returns `undefined` at `'off'`.
   */
  statsLevel?: StatsLevel;

  /**
   * Filesystem sync policy for bridge-driven wire-protocol calls.
   *
   * Default `'auto'`: disables per-query sync for clearly in-memory PGlite
   * instances and keeps it enabled otherwise. Set `true` to prefer durability
   * on persistent stores, or `false` to prefer lower RSS / higher throughput.
   *
   * If you provide a custom persistent PGlite `fs` without a meaningful
   * `dataDir`, pass `true` explicitly.
   */
  syncToFs?: SyncToFsMode;
}

class PGliteBridge {
  readonly adapter: PrismaPg;
  readonly pglite: PGlite;
  readonly bridgeId: symbol;

  readonly #pool: PgBridgePool;
  readonly #stats: BridgeStats | undefined;
  readonly #snapshot: SnapshotManager;
  readonly #leakToken: object = {};
  #closing: Promise<void> | undefined;

  constructor(config: PGliteBridgeConfig) {
    const statsLevel = config.statsLevel ?? 'off';
    if (statsLevel !== 'off' && statsLevel !== 'basic' && statsLevel !== 'full') {
      throw new Error(`statsLevel must be 'off', 'basic', or 'full'; got ${String(statsLevel)}`);
    }

    this.pglite = config.pglite;
    this.bridgeId = config.bridgeId ?? Symbol('bridge');

    this.#pool = new PgBridgePool({ ...config, bridgeId: this.bridgeId });
    this.#stats = statsLevel === 'off' ? undefined : new BridgeStats(statsLevel);
    this.#snapshot = createSnapshotManager(this.pglite);

    this.adapter = new PrismaPg(this.#pool);

    leakRegistry.register(this.adapter, undefined, this.#leakToken);
  }

  resetDb = async (): Promise<void> => {
    this.#stats?.incrementResetDb();
    return this.#snapshot.resetDb();
  };

  snapshotDb = async (): Promise<void> => {
    return this.#snapshot.snapshotDb();
  };

  resetSnapshot = async (): Promise<void> => {
    return this.#snapshot.resetSnapshot();
  };

  close = async (): Promise<void> => {
    if (!this.#closing) {
      this.#closing = (async () => {
        const closeEntry = this.#stats ? process.hrtime.bigint() : undefined;
        await this.#pool.end();
        if (closeEntry !== undefined) {
          await this.#stats?.freeze(this.pglite, closeEntry);
        }
        leakRegistry.unregister(this.#leakToken);
      })();
    }
    return this.#closing;
  };

  stats = async (): Promise<Stats | undefined> => {
    return this.#stats ? this.#stats.snapshot(this.pglite) : undefined;
  };
}

export default PGliteBridge;
