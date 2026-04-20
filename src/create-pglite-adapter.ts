/**
 * Creates a Prisma adapter backed by in-process PGlite.
 *
 * No TCP, no Docker, no worker threads — everything runs in the same process.
 * Works for testing, development, seeding, and scripts.
 *
 * ```typescript
 * import { createPgliteAdapter } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const { adapter, resetDb } = await createPgliteAdapter();
 * const prisma = new PrismaClient({ adapter });
 *
 * beforeEach(() => resetDb());
 * ```
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { createPool } from './create-pool.ts';
import { AdapterStats, type Stats, type StatsLevel } from './utils/adapter-stats.ts';
import { getMigrationSQL, type MigrationsOptions } from './utils/migrations.ts';
import {
  isDatabaseInitialized,
  isValidSentinelRow,
  SENTINAL_COLLISON_ERROR_MESSAGE,
  SENTINEL_SCHEMA,
  SENTINEL_STATEMENTS,
  SENTINEL_TABLE,
  writeSentinel,
} from './utils/sentinel.ts';
import { createSnapshotManager } from './utils/snapshot.ts';
import { nsToMs } from './utils/time.ts';

export interface CreatePgliteAdapterOptions extends MigrationsOptions {
  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

  /** PGlite extensions (e.g., `{ uuid_ossp: uuidOssp() }`) */
  extensions?: import('@electric-sql/pglite').Extensions;

  /**
   * Maximum pool connections (default: 1).
   *
   * PGlite serialises queries inside its WASM runtime, so extra pool
   * connections cost memory without adding throughput.
   */
  max?: number;

  /**
   * Collect adapter/query telemetry. Default `0` (off, zero overhead).
   *
   * - `1` — timing (`durationMs`, `wasmInitMs`, `schemaSetupMs`, query
   *   percentiles) and counters (`queryCount`, `failedQueryCount`,
   *   `resetDbCalls`), plus `dbSizeBytes`.
   * - `2` — everything in level 1, plus `processPeakRssBytes` (process-wide,
   *   sampled) and session-lock wait statistics.
   *
   * Retrieve via `await adapter.stats()` — returns `undefined` at level 0.
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
   * The underlying PGlite instance for direct SQL, snapshots, or extensions.
   *
   * @remarks
   * Direct `pglite.exec()` / `pglite.query()` calls bypass the pool's
   * {@link SessionLock}. Avoid mixing direct calls with Prisma operations
   * inside a transaction — use them only for setup, teardown, or utilities
   * that run outside active Prisma transactions.
   */
  pglite: import('@electric-sql/pglite').PGlite;

  /**
   * Identity tag published on every `QUERY_CHANNEL` / `LOCK_WAIT_CHANNEL`
   * diagnostics event produced by this adapter's bridges. External
   * subscribers filter on it to isolate events from this adapter in
   * multi-adapter processes.
   */
  adapterId: symbol;

  /** Clear all user tables and discard session-local state. Call in `beforeEach` for per-test isolation. */
  resetDb: ResetDbFn;

  /** Snapshot current DB state. Subsequent `resetDb` calls restore to this snapshot. */
  snapshotDb: SnapshotDbFn;

  /** Discard the current snapshot. Subsequent `resetDb` calls truncate to empty. */
  resetSnapshot: ResetSnapshotFn;

  /**
   * Shut down pool and PGlite. Not needed in tests (process exit handles it).
   *
   * When `statsLevel > 0`, call `stats()` *after* `close()` to collect the
   * frozen snapshot — `durationMs` and `dbSizeBytes` are cached at the
   * moment `close()` is invoked, and subsequent `stats()` calls are safe.
   */
  close: () => Promise<void>;

  /**
   * Retrieve collected telemetry. Returns `undefined` when `statsLevel` was
   * `0` (or omitted). Never throws — field-level failures surface as
   * `undefined` values (see {@link Stats}).
   */
  stats: StatsFn;
}

/**
 * Creates a Prisma adapter backed by an in-process PGlite instance.
 *
 * Applies the schema and returns a ready-to-use adapter + a `resetDb`
 * function for clearing tables between tests.
 */
export const createPgliteAdapter = async (
  options: CreatePgliteAdapterOptions = {},
): Promise<PgliteAdapter> => {
  const statsLevel = options.statsLevel ?? 0;
  if (statsLevel < 0 || statsLevel > 2) {
    throw new Error(`statsLevel must be 0, 1, or 2; got ${statsLevel}`);
  }
  const adapterId = Symbol('adapter');
  const adapterStats = statsLevel === 0 ? undefined : new AdapterStats(statsLevel);

  const { pool, pglite, wasmInitMs } = await createPool({
    dataDir: options.dataDir,
    extensions: options.extensions,
    max: options.max,
    adapterId,
    telemetry: adapterStats,
  });
  if (adapterStats && wasmInitMs !== undefined) {
    adapterStats.markWasmInit(wasmInitMs);
  }

  const schemaStart = adapterStats ? process.hrtime.bigint() : undefined;
  if (!options.dataDir || !(await isDatabaseInitialized(pglite))) {
    const sql = await getMigrationSQL(options);
    const isMigrationSQL = !options.sql;

    if (isMigrationSQL) {
      let committed = false;
      try {
        await pglite.exec(`BEGIN;\n${sql};\n${SENTINEL_STATEMENTS}`);

        const { rows: verify } = await pglite.query<{ marker: string; version: number }>(
          `SELECT marker, version FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}"`,
        );
        if (!isValidSentinelRow(verify)) throw new Error(SENTINAL_COLLISON_ERROR_MESSAGE);
        await pglite.exec('COMMIT');
        committed = true;
      } catch (err) {
        if (!committed) await pglite.exec('ROLLBACK');
        if (err instanceof Error && err.message === SENTINAL_COLLISON_ERROR_MESSAGE) throw err;
        throw new Error(
          'Failed to apply schema SQL to PGlite. Check your schema or migration files.',
          { cause: err },
        );
      }
    } else {
      try {
        await pglite.exec(sql);
      } catch (err) {
        throw new Error(
          'Failed to apply schema SQL to PGlite. Check your schema or migration files.',
          { cause: err },
        );
      }
      await writeSentinel(pglite);
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

  let closing: Promise<void> | undefined;
  const close = async () => {
    if (closing) return closing;
    closing = (async () => {
      const closeEntry = adapterStats ? process.hrtime.bigint() : undefined;
      await pool.end();
      if (adapterStats && closeEntry !== undefined) {
        await adapterStats.freeze(pglite, closeEntry);
      }
      await pglite.close();
    })();
    return closing;
  };

  return {
    adapter,
    adapterId,
    close,
    pglite,
    resetDb,
    resetSnapshot: snapshotManager.resetSnapshot,
    snapshotDb: snapshotManager.snapshotDb,
    stats: async () => (adapterStats ? adapterStats.snapshot(pglite) : undefined),
  };
};
