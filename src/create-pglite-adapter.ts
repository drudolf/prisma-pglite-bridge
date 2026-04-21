/**
 * Creates a Prisma adapter backed by a caller-supplied PGlite instance.
 *
 * No TCP, no Docker, no worker threads — everything runs in the same process.
 * Works for testing, development, seeding, and scripts.
 *
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { createPgliteAdapter } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * const { adapter, resetDb } = await createPgliteAdapter({
 *   pglite,
 *   migrationsPath: './prisma/migrations',
 * });
 * const prisma = new PrismaClient({ adapter });
 *
 * beforeEach(() => resetDb());
 * ```
 */
import type { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPool } from './create-pool.ts';
import { AdapterStats, type Stats, type StatsLevel } from './utils/adapter-stats.ts';
import { getMigrationSQL, type MigrationsOptions } from './utils/migrations.ts';
import { createSnapshotManager } from './utils/snapshot.ts';
import { nsToMs } from './utils/time.ts';

/** @internal Exported for testing. */
export const emitAdapterLeakWarning = (adapterId: symbol): void => {
  process.emitWarning(
    `PGlite adapter "${String(adapterId)}" was garbage-collected before close() was called. ` +
      'Call adapter.close() to release the pool and finalize stats().',
    { type: 'PgliteAdapterLeakWarning' },
  );
};

const leakRegistry = new FinalizationRegistry(emitAdapterLeakWarning);

export interface CreatePgliteAdapterOptions extends MigrationsOptions {
  /**
   * PGlite instance to bridge to. The caller owns its lifecycle — `close()`
   * shuts down the pool only, not the PGlite instance.
   */
  pglite: PGlite;

  /**
   * Maximum pool connections (default: 1).
   *
   * PGlite serialises queries inside its WASM runtime, so extra pool
   * connections cost memory without adding throughput.
   */
  max?: number;

  /**
   * Collect adapter/query telemetry. Default `'off'` (zero overhead).
   *
   * - `'basic'` — timing (`durationMs`, `schemaSetupMs`, query percentiles)
   *   and counters (`queryCount`, `failedQueryCount`, `resetDbCalls`), plus
   *   `dbSizeBytes`.
   * - `'full'` — everything in `'basic'`, plus `processRssPeakBytes`
   *   (process-wide, sampled) and session-lock wait statistics.
   *
   * Retrieve via `await adapter.stats()` — returns `undefined` at `'off'`.
   */
  statsLevel?: StatsLevel;
}

/** Snapshot of adapter/query telemetry. See {@link CreatePgliteAdapterOptions.statsLevel}. */
export type StatsFn = () => Promise<Stats | undefined>;

/** Clear all user tables and discard session-local state. Call in `beforeEach` for per-test isolation. */
export type ResetDbFn = () => Promise<void>;

export type SnapshotDbFn = () => Promise<void>;

export type ResetSnapshotFn = () => Promise<void>;

export interface PgliteAdapter {
  /** Prisma adapter — pass directly to `new PrismaClient({ adapter })` */
  adapter: PrismaPg;

  /**
   * Identity tag published on every `QUERY_CHANNEL` / `LOCK_WAIT_CHANNEL`
   * diagnostics event produced by this adapter's bridges. External
   * subscribers filter on it to isolate events from this adapter in
   * multi-adapter processes.
   */
  adapterId: symbol;

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
  close: () => Promise<void>;

  /**
   * Retrieve collected telemetry. Returns `undefined` when `statsLevel` was
   * `'off'` (or omitted). Never throws — field-level failures surface as
   * `undefined` values (see {@link Stats}).
   */
  stats: StatsFn;
}

/**
 * Creates a Prisma adapter backed by a caller-supplied PGlite instance.
 *
 * When migration config is provided (`sql`, `migrationsPath`, or
 * `configRoot`), the resolved SQL is applied once on construction.
 * Otherwise, the PGlite instance is assumed to already hold the schema —
 * useful for reopening a persistent `dataDir`.
 */
export const createPgliteAdapter = async (
  options: CreatePgliteAdapterOptions,
): Promise<PgliteAdapter> => {
  const statsLevel = options.statsLevel ?? 'off';
  if (statsLevel !== 'off' && statsLevel !== 'basic' && statsLevel !== 'full') {
    throw new Error(`statsLevel must be 'off', 'basic', or 'full'; got ${String(statsLevel)}`);
  }
  const adapterId = Symbol('adapter');
  const adapterStats = statsLevel === 'off' ? undefined : new AdapterStats(statsLevel);

  const { pglite } = options;

  const { pool } = await createPool({
    pglite,
    max: options.max,
    adapterId,
    telemetry: adapterStats,
  });

  const hasMigrationConfig =
    options.sql !== undefined ||
    options.migrationsPath !== undefined ||
    options.configRoot !== undefined;

  const schemaStart = adapterStats ? process.hrtime.bigint() : undefined;
  if (hasMigrationConfig) {
    const sql = await getMigrationSQL(options);
    try {
      await pglite.exec(sql);
    } catch (err) {
      const target = pglite.dataDir ? `PGlite(dataDir=${pglite.dataDir})` : 'in-memory PGlite';
      throw new Error(
        `Failed to apply schema SQL to ${target}. Check your schema or migration files.`,
        { cause: err },
      );
    }
  }
  if (adapterStats && schemaStart !== undefined) {
    adapterStats.markSchemaSetup(nsToMs(process.hrtime.bigint() - schemaStart));
  }

  const adapter = new PrismaPg(pool);
  const snapshotManager = createSnapshotManager(pglite);

  const resetDb: ResetDbFn = async () => {
    adapterStats?.incrementResetDb();
    await snapshotManager.resetDb();
  };

  const leakToken: object = {};

  let closing: Promise<void> | undefined;
  const close = async () => {
    if (!closing) {
      closing = (async () => {
        const closeEntry = adapterStats ? process.hrtime.bigint() : undefined;
        await pool.end();
        if (adapterStats && closeEntry !== undefined) {
          await adapterStats.freeze(pglite, closeEntry);
        }
        leakRegistry.unregister(leakToken);
      })();
    }
    return closing;
  };

  const result: PgliteAdapter = {
    adapter,
    adapterId,
    close,
    resetDb,
    resetSnapshot: snapshotManager.resetSnapshot,
    snapshotDb: snapshotManager.snapshotDb,
    stats: async () => (adapterStats ? adapterStats.snapshot(pglite) : undefined),
  };

  leakRegistry.register(result, adapterId, leakToken);

  return result;
};
