/**
 * Creates a PGliteBridge: a Prisma adapter, the underlying PGlite instance,
 * and lifecycle helpers, all backed by a caller-supplied PGlite instance.
 *
 * No TCP, no Docker, no worker threads — everything runs in the same process.
 * Works for testing, development, seeding, and scripts.
 *
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * const bridge = await createPGliteBridge({ pglite });
 * await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
 *
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * beforeEach(() => bridge.resetDb());
 * ```
 */
import type { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPool, type SyncToFsMode } from './pool.ts';
import { BridgeStats, type Stats, type StatsLevel } from './utils/bridge-stats.ts';
import { createSnapshotManager } from './utils/snapshot.ts';

/** @internal Exported for testing. */
export const emitBridgeLeakWarning = (): void => {
  process.emitWarning(
    'PGliteBridge was garbage-collected before close() was called. ' +
      'Call bridge.close() to release the pool and finalize stats().',
    { type: 'PGliteBridgeLeakWarning' },
  );
};

const leakRegistry = new FinalizationRegistry<void>(emitBridgeLeakWarning);

export interface PGliteBridgeOptions {
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

/** Snapshot of bridge/query telemetry. See {@link PGliteBridgeOptions.statsLevel}. */
export type StatsFn = () => Promise<Stats | undefined>;

/** Clear all user tables and discard session-local state. Call in `beforeEach` for per-test isolation. */
export type ResetDbFn = () => Promise<void>;

export type SnapshotDbFn = () => Promise<void>;

export type ResetSnapshotFn = () => Promise<void>;

export type CloseFn = () => Promise<void>;

export interface PGliteBridge {
  /** Prisma adapter — pass directly to `new PrismaClient({ adapter })` */
  adapter: PrismaPg;

  /**
   * The caller-supplied PGlite instance this bridge wraps. Exposed so
   * helpers like {@link pushMigrations} can run SQL directly through
   * `pglite.exec(...)` without going through the bridge pool.
   */
  pglite: PGlite;

  /**
   * Identity tag published on every `QUERY_CHANNEL` / `LOCK_WAIT_CHANNEL`
   * diagnostics event produced by this bridge. External subscribers
   * filter on it to isolate events from this bridge in multi-bridge
   * processes.
   */
  bridgeId: symbol;

  /** Clear all user tables and discard session-local state. Call in `beforeEach` for per-test isolation. */
  resetDb: ResetDbFn;

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
  snapshotDb: SnapshotDbFn;

  /**
   * Discard the current snapshot. Subsequent `resetDb` calls truncate to
   * empty. Same concurrency requirements as {@link snapshotDb}.
   */
  resetSnapshot: ResetSnapshotFn;

  /**
   * Shut down the pool. The caller-owned PGlite instance is not closed.
   *
   * When `statsLevel` is not `'off'`, call `stats()` *after* `close()` to
   * collect the frozen snapshot — `durationMs` and `dbSizeBytes` are cached
   * at the moment `close()` is invoked, and subsequent `stats()` calls are
   * safe.
   */
  close: CloseFn;

  /**
   * Retrieve collected telemetry. Returns `undefined` when `statsLevel` was
   * `'off'` (or omitted). Never throws — field-level failures surface as
   * `undefined` values (see {@link Stats}).
   */
  stats: StatsFn;
}

/**
 * Creates a `PGliteBridge` — a bundle holding a Prisma driver adapter,
 * the underlying PGlite instance, and lifecycle helpers — backed by a
 * caller-supplied PGlite instance.
 *
 * Schema application is a separate concern — call {@link pushMigrations}
 * (raw SQL / migrations directory) or {@link pushSchema} (WASM-engine
 * diff) before issuing Prisma traffic. When reopening a persistent
 * `dataDir`, the PGlite instance is assumed to already hold the schema
 * and no migration step is required.
 */
export const createPGliteBridge = async (options: PGliteBridgeOptions): Promise<PGliteBridge> => {
  const statsLevel = options.statsLevel ?? 'off';
  if (statsLevel !== 'off' && statsLevel !== 'basic' && statsLevel !== 'full') {
    throw new Error(`statsLevel must be 'off', 'basic', or 'full'; got ${String(statsLevel)}`);
  }
  const bridgeId = Symbol('bridge');
  const bridgeStats = statsLevel === 'off' ? undefined : new BridgeStats(statsLevel);

  const { pglite } = options;

  const { pool } = await createPool({
    pglite,
    max: options.max,
    bridgeId,
    syncToFs: options.syncToFs,
    telemetry: bridgeStats,
  });

  const adapter = new PrismaPg(pool);
  const snapshotManager = createSnapshotManager(pglite);

  const resetDb: ResetDbFn = async () => {
    bridgeStats?.incrementResetDb();
    await snapshotManager.resetDb();
  };

  const leakToken: object = {};

  let closing: Promise<void> | undefined;
  const close: CloseFn = async () => {
    if (!closing) {
      closing = (async () => {
        const closeEntry = bridgeStats ? process.hrtime.bigint() : undefined;
        await pool.end();
        if (bridgeStats && closeEntry !== undefined) {
          await bridgeStats.freeze(pglite, closeEntry);
        }
        leakRegistry.unregister(leakToken);
      })();
    }
    return closing;
  };

  const result: PGliteBridge = {
    adapter,
    bridgeId,
    pglite,
    close,
    resetDb,
    resetSnapshot: snapshotManager.resetSnapshot,
    snapshotDb: snapshotManager.snapshotDb,
    stats: async () => (bridgeStats ? bridgeStats.snapshot(pglite) : undefined),
  };

  // Track the lifetime of the Prisma adapter instance users actually retain.
  // The wrapper object returned by createPGliteBridge() is often ephemeral
  // (`const adapter = (await createPGliteBridge(...)).adapter`), so
  // registering that wrapper causes false leak warnings while Prisma still
  // holds the live adapter and pool.
  leakRegistry.register(adapter, undefined, leakToken);

  return result;
};
