/**
 * `PGliteBridge` bundles a Prisma driver adapter, the underlying PGlite
 * instance, and lifecycle helpers. No TCP, no Docker, no worker threads —
 * everything runs in the same process. Suitable for testing, development,
 * seeding, and scripts.
 *
 * **Ownership:** When no `pglite` option is supplied the bridge creates its
 * own in-memory `PGlite` instance and owns it — `close()` shuts down the
 * pool _and_ the PGlite instance. When you supply a `pglite` the bridge
 * treats it as caller-owned and `close()` leaves it open.
 *
 * Schema application is a separate concern: call {@link pushMigrations}
 * (raw SQL / migrations directory) or {@link pushSchema} (WASM-engine diff)
 * before issuing Prisma traffic. When reopening a persistent `dataDir`, the
 * PGlite instance is assumed to already hold the schema.
 *
 * ```typescript
 * import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * // Bridge creates and owns its own in-memory PGlite:
 * const bridge = new PGliteBridge();
 * await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * beforeEach(() => bridge.resetDb());
 * afterAll(async () => {
 *   await prisma.$disconnect();
 *   await bridge.close(); // closes pool + pglite (bridge owns it)
 * });
 *
 * // Caller-supplied PGlite — caller owns the lifecycle:
 * import { PGlite } from '@electric-sql/pglite';
 * const pglite = new PGlite();
 * const bridge = new PGliteBridge({ pglite });
 * afterAll(async () => {
 *   await bridge.close(); // closes pool only; pglite stays open
 *   await pglite.close(); // caller is responsible
 * });
 * ```
 *
 * Public methods are arrow-function class fields so destructuring stays safe:
 * `const { resetDb } = bridge; await resetDb();` works as expected.
 */
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';

import { PgBridgeError } from '../errors.ts';
import { assertPoolMax, PgBridgePool } from '../pool';
import { BridgeStats, type Stats, type StatsLevel } from '../telemetry/bridge-stats.ts';
import { assertPoolIdle } from '../utils/assert-pool-idle.ts';
import type { SyncToFsMode } from '../utils/resolve-sync-to-fs.ts';
import type { BridgeWarningType } from '../warnings.ts';
import { SnapshotManager } from './snapshot-manager.ts';

/** @internal Exported for testing. */
export const emitBridgeLeakWarning = (): void => {
  process.emitWarning(
    'PGliteBridge was garbage-collected before close() was called. ' +
      'Call bridge.close() to release the pool and finalize stats().',
    { type: 'PGliteBridgeLeakWarning' satisfies BridgeWarningType },
  );
};

const leakRegistry = new FinalizationRegistry<void>(emitBridgeLeakWarning);

export interface PGliteBridgeOptions {
  /**
   * Identity tag published with every diagnostics-channel event. Subscribers
   * filter on this to distinguish events from different bridges in the
   * same process. A fresh `Symbol('bridge')` is generated if omitted.
   */
  bridgeId?: symbol;

  /**
   * PGlite instance to bridge to. When omitted the bridge creates its own
   * in-memory `PGlite` and owns its lifecycle — `close()` shuts it down.
   * When provided the caller owns the lifecycle — `close()` leaves it open.
   */
  pglite?: PGlite | PGliteInterface;

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

  /**
   * Maximum milliseconds pg-pool waits for its entire checkout path:
   * creating and connecting a logical client, or waiting for one when all
   * `max` clients are checked out. Defaults to an unbounded wait. Distinct
   * from {@link query_timeout} on a checked-out client and the bridge
   * readiness {@link timeout}; on an initial checkout,
   * `connectionTimeoutMillis` and `timeout` may bound different portions of
   * the operation. Forwarded to the pool unchanged.
   */
  connectionTimeoutMillis?: number;

  /**
   * Milliseconds an idle pool client lives before eviction. Defaults to `0`
   * (never evict) — an in-process duplex client holds no socket or server
   * resource, and evicting it would discard its prepared-statement cache
   * for no benefit. Forwarded to the pool unchanged.
   */
  idleTimeoutMillis?: number;

  /**
   * Route adapter-pg-shaped queries through the pool's lean fast path that
   * skips the Describe round-trip on repeat executions. Default `true`.
   * See `PgBridgePoolOptions.fastQueryPath` for the full contract. Set
   * `false` to route everything through stock pg. Forwarded to the pool
   * unchanged.
   */
  fastQueryPath?: boolean;

  /**
   * Maximum milliseconds from an ordinary Prisma/pg query call on a checked-out
   * client until its caller rejects with `Query read timeout`. A truthy
   * per-query `query_timeout` overrides this default; per-query `0` falls back
   * to it, matching pg. Includes this bridge's submission-chain wait, but not
   * pool checkout, and does not cancel work already admitted to PGlite.
   */
  query_timeout?: number;

  /**
   * Cache Prisma queries as named prepared statements, so PGlite parses
   * and plans each query shape once per client session instead of on every
   * execution (~7% lower read p50, ~18% lower p99 in the reference
   * benchmark). Statements survive {@link PGliteBridge.resetDb} — tables
   * are truncated, never dropped, so retained statements revalidate
   * transparently and the cache stays warm across per-test resets.
   *
   * Default: enabled. Statement names are unique per pool client, so any
   * `max` and any number of pools or bridges sharing one PGlite instance
   * cache safely and concurrently — no opt-out or coordination needed.
   * *User-supplied* statement names (`query({ name: ... })` on the pool)
   * are the exception: they bypass name injection and remain
   * single-client-only on the shared session.
   *
   * Set `false` when you issue DDL mid-session that changes the result
   * type of an already-cached query shape (fails with "cached plan must
   * not change result type" — see docs/troubleshooting.md). Applying
   * schema before Prisma traffic, as the setup helpers do, is safe.
   *
   * The cache names a query text on its second sighting (one-shot shapes
   * never consume slots) and holds 500 shapes per client; past that the
   * least-recently-used statement is evicted and freed on the wire. Only
   * SELECT / INSERT / UPDATE / DELETE / WITH / MERGE / VALUES statements
   * are named — DDL and transaction control never consume cache slots.
   */
  preparedStatements?: boolean;

  /**
   * Target a non-`public` PostgreSQL schema. Forwarded to
   * `@prisma/adapter-pg` as its `schema` option, which sets the
   * connection `search_path` so Prisma reads and writes in that schema.
   * Omit to use `public`.
   */
  schema?: string;
}

export class PGliteBridge {
  /** Prisma adapter — pass directly to `new PrismaClient({ adapter })`. */
  readonly adapter: PrismaPg;

  /**
   * The PGlite instance this bridge wraps. Created internally when no
   * `pglite` option was supplied; otherwise the caller-supplied instance.
   * Exposed so helpers like {@link pushMigrations} can run SQL directly
   * through `pglite.exec(...)` without going through the bridge pool.
   */
  readonly pglite: PGlite | PGliteInterface;

  /**
   * Identity tag published on every `QUERY_CHANNEL` / `LOCK_WAIT_CHANNEL`
   * diagnostics event produced by this bridge. External subscribers
   * filter on it to isolate events from this bridge in multi-bridge
   * processes. Stable for the lifetime of the bridge instance — the same
   * `symbol` reference appears on every event from the same bridge.
   */
  readonly bridgeId: symbol;

  readonly #pool: PgBridgePool;
  readonly #stats: BridgeStats | undefined;
  readonly #snapshot: SnapshotManager;
  readonly #leakToken: object = {};
  readonly #ownsPglite: boolean;
  #closing: Promise<void> | undefined;

  /**
   * @throws {TypeError} when `max` is not a positive integer (validated
   *   before the owned PGlite is created).
   * @throws {PgBridgeError} `INVALID_STATS_LEVEL` for an unrecognized
   *   `statsLevel`.
   */
  constructor(options: PGliteBridgeOptions = {}) {
    // Validate before any PGlite is created so a rejected configuration
    // cannot leak an unclosed WASM instance. `?? 1` mirrors the pool
    // constructor's own destructure default for an omitted max.
    assertPoolMax(options.max ?? 1);
    const statsLevel = options.statsLevel ?? 'off';
    if (statsLevel !== 'off' && statsLevel !== 'basic' && statsLevel !== 'full') {
      throw new PgBridgeError(
        'INVALID_STATS_LEVEL',
        `statsLevel must be 'off', 'basic', or 'full'; got ${String(statsLevel)}`,
      );
    }

    const preparedStatements = options.preparedStatements ?? true;

    this.#ownsPglite = !options.pglite;
    this.pglite = options.pglite ?? new PGlite();
    this.bridgeId = options.bridgeId ?? Symbol('bridge');

    this.#stats = statsLevel === 'off' ? undefined : new BridgeStats(statsLevel);
    this.#pool = new PgBridgePool({
      ...options,
      pglite: this.pglite,
      bridgeId: this.bridgeId,
      telemetry: this.#stats,
      // Mirror preparedStatements into the pool: name injection happens at
      // the pool-client layer, which covers the adapter path and direct pool
      // queries (e.g. Drizzle) alike — no adapter-side generator needed.
      statementCaching: preparedStatements,
    });
    this.#snapshot = new SnapshotManager(this.pglite);

    // Forward only the adapter-pg options the caller actually set, so the
    // adapter keeps its own defaults otherwise: `schema` targets a
    // non-public search_path.
    const adapterOptions: NonNullable<ConstructorParameters<typeof PrismaPg>[1]> = {};
    if (options.schema !== undefined) {
      adapterOptions.schema = options.schema;
    }
    try {
      this.adapter = new PrismaPg(
        this.#pool,
        Object.keys(adapterOptions).length > 0 ? adapterOptions : undefined,
      );
    } catch (err) {
      // The half-constructed bridge is unreachable after a throw, so nothing
      // would ever call close() — release the pool (whose end() frees its
      // shared-instance slot synchronously) and, when the bridge created its
      // own PGlite, close that instance too before rethrowing. Constructors
      // cannot await; the async remainder is best-effort.
      void this.#pool
        .end()
        .catch(
          /* v8 ignore next — end() on a never-used pool does not reject */
          () => {},
        )
        .then(() => (this.#ownsPglite ? this.pglite.close() : undefined))
        .catch(() => {});
      throw err;
    }

    leakRegistry.register(this.adapter, undefined, this.#leakToken);
  }

  /**
   * Clear all user tables and discard session-local state. Call in
   * `beforeEach` for per-test isolation. When a snapshot has been taken
   * via {@link snapshotDb}, restores from that snapshot instead of
   * truncating to empty.
   *
   * Throws if any pool client is currently checked out or a checkout is
   * still waiting for dispatch — the operation runs raw SQL on the PGlite
   * instance bypassing the pool, so concurrent pool traffic would
   * interleave unsafely. Await all pending Prisma queries first.
   *
   * @throws {PgBridgeError} `POOL_NOT_IDLE` under the conditions above;
   *   `SNAPSHOT_INVALID` when a snapshot restore finds the schema changed
   *   since {@link snapshotDb} (re-run `snapshotDb()` after schema changes).
   */
  resetDb = async (): Promise<void> => {
    this.#assertPoolIdle('resetDb');
    this.#stats?.incrementResetDb();
    return this.#snapshot.resetDb();
  };

  /**
   * Snapshot the current DB state into an internal `_pglite_snapshot`
   * schema. Subsequent `resetDb` calls restore from this snapshot instead
   * of truncating to empty.
   *
   * Throws if any pool client is currently checked out or a checkout is
   * still waiting for dispatch — the operation runs multiple `exec()`
   * statements directly against the PGlite instance, bypassing the pool's
   * `SessionLock`. Call from a test `beforeAll` after migrations but
   * before Prisma traffic starts.
   *
   * @throws {PgBridgeError} `POOL_NOT_IDLE` under the conditions above.
   */
  snapshotDb = async (): Promise<void> => {
    this.#assertPoolIdle('snapshotDb');
    return this.#snapshot.snapshotDb();
  };

  /**
   * Discard the current snapshot. Subsequent `resetDb` calls truncate to
   * empty. Same concurrency requirements as {@link snapshotDb} — throws if
   * any pool client is checked out or a checkout is waiting for dispatch.
   *
   * @throws {PgBridgeError} `POOL_NOT_IDLE` under the conditions above.
   */
  resetSnapshot = async (): Promise<void> => {
    this.#assertPoolIdle('resetSnapshot');
    return this.#snapshot.resetSnapshot();
  };

  #assertPoolIdle(method: string): void {
    // Shared busy-count logic (and its same-tick waitingCount rationale)
    // lives in utils/assert-pool-idle.ts; the advice sentence stays
    // Prisma-flavored here, byte-identical to the pre-extraction message.
    assertPoolIdle(
      this.#pool,
      method,
      'Await all pending Prisma queries (or end an open `$transaction`) before calling.',
    );
  }

  /**
   * Shut down the pool. When the bridge created its own PGlite (no `pglite`
   * option at construction), also closes that instance. When the caller
   * supplied a `pglite`, it is left open — the caller is responsible for
   * closing it.
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
        if (this.#ownsPglite && !this.pglite.closed) {
          await this.pglite.close();
        }
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
