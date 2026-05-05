/**
 * `PGliteBridge` bundles a Prisma driver adapter, the underlying PGlite
 * instance, and lifecycle helpers — all backed by a caller-supplied PGlite
 * instance. No TCP, no Docker, no worker threads — everything runs in the
 * same process. Suitable for testing, development, seeding, and scripts.
 *
 * Schema application is a separate concern: call {@link pushMigrations}
 * (raw SQL / migrations directory) or {@link pushSchema} (WASM-engine
 * diff) before issuing Prisma traffic. When reopening a persistent
 * `dataDir`, the PGlite instance is assumed to already hold the schema
 * and no migration step is required.
 *
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
 *
 * const bridge = new PGliteBridge({ pglite });
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * beforeEach(() => bridge.resetDb());
 * ```
 *
 * Public methods are arrow-function class fields so destructuring stays safe:
 * `const { resetDb } = bridge; await resetDb();` works as expected.
 */
import type { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';

import PgBridgePool from '../pool/index.ts';
import { BridgeStats, type Stats, type StatsLevel } from '../telemetry/bridge-stats.ts';
import type { SyncToFsMode } from '../utils/resolve-sync-to-fs.ts';
import { SnapshotManager } from './snapshot-manager.ts';

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

  /**
   * Maximum milliseconds to wait for the PGlite instance to become ready
   * before each bridge operation. Defaults to no timeout (waits indefinitely),
   * matching the previous unbounded `await pglite.waitReady` behavior.
   */
  timeout?: number;
}

class PGliteBridge {
  /** Prisma adapter — pass directly to `new PrismaClient({ adapter })`. */
  readonly adapter: PrismaPg;

  /**
   * The caller-supplied PGlite instance this bridge wraps. Exposed so
   * helpers like {@link pushMigrations} can run SQL directly through
   * `pglite.exec(...)` without going through the bridge pool.
   */
  readonly pglite: PGlite;

  /**
   * Identity tag published on every `QUERY_CHANNEL` / `LOCK_WAIT_CHANNEL`
   * diagnostics event produced by this bridge. External subscribers
   * filter on it to isolate events from this bridge in multi-bridge
   * processes.
   */
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

    this.#stats = statsLevel === 'off' ? undefined : new BridgeStats(statsLevel);
    this.#pool = new PgBridgePool({
      ...config,
      bridgeId: this.bridgeId,
      telemetry: this.#stats,
    });
    this.#snapshot = new SnapshotManager(this.pglite);

    this.adapter = new PrismaPg(this.#pool);

    leakRegistry.register(this.adapter, undefined, this.#leakToken);
  }

  /**
   * Clear all user tables and discard session-local state. Call in
   * `beforeEach` for per-test isolation. When a snapshot has been taken
   * via {@link snapshotDb}, restores from that snapshot instead of
   * truncating to empty.
   */
  resetDb = async (): Promise<void> => {
    this.#stats?.incrementResetDb();
    return this.#snapshot.resetDb();
  };

  /**
   * Snapshot the current DB state into an internal `_pglite_snapshot`
   * schema. Subsequent `resetDb` calls restore from this snapshot instead
   * of truncating to empty.
   *
   * **Concurrency:** runs multiple `exec()` statements directly against
   * the PGlite instance, bypassing the pool's `SessionLock`. Call from a
   * test `beforeAll` after migrations but before Prisma traffic starts;
   * invoking it while another pool connection is inside a transaction is
   * unsafe and may deadlock against PGlite's internal mutex.
   */
  snapshotDb = async (): Promise<void> => {
    return this.#snapshot.snapshotDb();
  };

  /**
   * Discard the current snapshot. Subsequent `resetDb` calls truncate to
   * empty. Same concurrency requirements as {@link snapshotDb}.
   */
  resetSnapshot = async (): Promise<void> => {
    return this.#snapshot.resetSnapshot();
  };

  /**
   * Shut down the pool. The caller-owned PGlite instance is not closed.
   *
   * When `statsLevel` is not `'off'`, call {@link stats} *after* `close()`
   * to collect the frozen snapshot — `durationMs` and `dbSizeBytes` are
   * cached at the moment `close()` is invoked, and subsequent `stats()`
   * calls are safe.
   */
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

  /**
   * Retrieve collected telemetry. Returns `undefined` when `statsLevel`
   * was `'off'` (or omitted). Never throws — field-level failures surface
   * as `undefined` values (see {@link Stats}).
   */
  stats = async (): Promise<Stats | undefined> => {
    return this.#stats ? this.#stats.snapshot(this.pglite) : undefined;
  };
}

export default PGliteBridge;
