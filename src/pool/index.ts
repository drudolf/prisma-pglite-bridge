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
  extends Omit<
    PgBridgeClientOptions,
    // Pool-managed: the pool builds its own SessionLock, probes PGlite's
    // cleanup needs, and resolves the statementCaching default (redeclared
    // below with pool-level docs).
    | 'pglite'
    | 'bridgeId'
    | 'syncToFs'
    | 'telemetry'
    | 'sessionLock'
    | 'protocolCleanupNeeded'
    | 'statementCaching'
  > {
  /**
   * PGlite instance to back the pool. When omitted the pool creates its own
   * in-memory `PGlite` and owns its lifecycle — `end()` shuts it down. When
   * provided the caller owns the lifecycle — `end()` leaves it open.
   *
   * Multiple concurrent pools on one PGlite instance are supported but emit
   * `PGliteBridgeSharedInstanceWarning` as an advisory: queries from all
   * pools serialize through PGlite's WASM mutex (no added throughput), and
   * transactions from different pools can interleave — coordinate explicitly
   * if isolation across pools matters. Named-statement caching stays active
   * across pools — statement names are client-unique, so pools never collide
   * (see {@link statementCaching}).
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

  /**
   * Milliseconds an idle pool client lives before eviction. Defaults to
   * `0` (never evict) — an in-process duplex client holds no socket or
   * server resource, and evicting it would discard its prepared-statement
   * cache and re-run connect-time session cleanup for no benefit. Set a
   * positive value to restore `pg.Pool`'s usual eviction behavior.
   */
  idleTimeoutMillis?: number;

  /**
   * Cache query plans via named prepared statements for all queries issued
   * through this pool (default: enabled). Each pool client injects a stable
   * `ppb_<namespace>_<n>` name into unnamed DML queries so PostgreSQL parses
   * and plans each query shape once per client and skips Parse on repeat
   * executions. Only DML (SELECT / INSERT / UPDATE / DELETE / WITH / MERGE /
   * VALUES) is named; DDL, SET, and transaction control always run unnamed.
   * Bounded at 500 distinct texts per client; shapes beyond that run unnamed
   * (correct, just uncached).
   *
   * Names are unique per client (`<namespace>` draws from a process-wide
   * counter), so multiple pool clients (`max > 1`) and multiple pools on one
   * PGlite instance cache safely and concurrently — bridge-injected names
   * never collide in the shared session. *User-supplied* statement names
   * (`query({ name: ... })`) are the exception: they bypass injection and
   * remain single-client-only — two clients Parsing the same user-chosen
   * name still collide (Postgres error 42P05), as on any shared session.
   *
   * `DEALLOCATE` and `DISCARD ALL` issued through any pool client evict the
   * affected names from every live client's plan cache on this instance, so
   * repeat executions re-Parse instead of failing with error 26000.
   */
  statementCaching?: boolean;

  /**
   * Route queries matching the adapter-pg shape — named statement,
   * `rowMode: 'array'`, caller-supplied `types` — through a lean pg
   * Submittable that caches result-field metadata per statement and skips
   * the Describe round-trip on repeat executions (~30% lower point-lookup
   * latency and a much tighter worst case in the reference probe). Result
   * values are identical; the resolved object is a plain
   * `{ rows, fields, rowCount, command, oid }` rather than a `pg.Result`
   * instance. Every other query shape uses the stock pg path. Set `false`
   * to route everything through stock pg. Neither the bridge nor
   * adapter-pg uses pg's query-cancellation API, which the fast path does
   * not implement. Default `true`.
   */
  fastQueryPath?: boolean;
}

// Live pools per PGlite instance. Drives the PGliteBridgeSharedInstanceWarning.
const livePoolCounts = new WeakMap<object, number>();

// Total pg.Client instances across ALL pools per PGlite instance.
// Incremented in 'connect', decremented in 'remove'. The connect-time
// DEALLOCATE ALL guard checks this instead of per-pool totalCount so that
// a new pool's first client never wipes a sibling pool's server-side named
// statements mid-flight (would cause 26000 on the sibling's next Bind).
const liveClientCounts = new WeakMap<object, number>();

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
    idleTimeoutMillis = 0,
    fastQueryPath,
    statementCaching,
  }: PgBridgePoolOptions & { telemetry?: TelemetrySink } = {}) {
    const resolvedPglite = pglite ?? new PGlite();

    // Load-bearing: pg.Pool forwards this config object verbatim to
    // `new Client(config)`, including the symbol-keyed property below.
    // PgBridgeClient reads its bridge options from the same symbol.
    const poolConfig = {
      Client: PgBridgeClient,
      max,
      idleTimeoutMillis,
      [PgBridgeClient.OptionsKey]: {
        pglite: resolvedPglite,
        sessionLock: max > 1 ? new SessionLock() : undefined,
        bridgeId,
        telemetry,
        syncToFs: resolveSyncToFs(resolvedPglite, syncToFs),
        timeout,
        protocolCleanupNeeded: pgliteNeedsProtocolCleanup(),
        fastQueryPath,
        statementCaching: statementCaching !== false,
      },
    };

    super(poolConfig);

    this.bridgeId = bridgeId;
    this.pglite = resolvedPglite;
    this.#ownsPglite = !pglite;

    const liveCount = (livePoolCounts.get(resolvedPglite) ?? 0) + 1;
    livePoolCounts.set(resolvedPglite, liveCount);
    if (liveCount > 1) {
      process.emitWarning(
        'Multiple live PgBridgePools share one PGlite instance. Queries from all ' +
          "pools serialize through PGlite's WASM mutex — adding pools does not " +
          'increase throughput. Concurrent transactions from different pools ' +
          'may interleave; for transaction isolation across pools coordinate ' +
          "explicitly (await one pool's transaction before starting another's).",
        { type: 'PGliteBridgeSharedInstanceWarning' },
      );
    }

    // A fresh session (no live clients on this PGlite across ALL pools) must
    // start with an empty prepared-statement namespace: earlier, since-
    // destroyed clients may have left named statements behind, and reclaiming
    // them keeps the shared session from accumulating dead generations. pg
    // serializes queries per client, so this runs before the client's first
    // query. prevClientCount > 0 means another live client holds server-side
    // named statements — wiping them would cause 26000 on its next Bind, so
    // the cleanup fires only on the 0→1 transition. The count can only
    // overcount (increment here is synchronous; decrement in 'remove' is
    // async), so at worst the cleanup is *skipped* because a dead client has
    // not been removed yet — benign: client-unique statement names cannot
    // collide with the leftovers, which persist only until the session next
    // quiesces to zero live clients.
    this.on('connect', (client) => {
      const prevClientCount = liveClientCounts.get(resolvedPglite) ?? 0;
      liveClientCounts.set(resolvedPglite, prevClientCount + 1);
      if (prevClientCount > 0) return;
      void client.query('DEALLOCATE ALL').catch(() => {
        // Best-effort: a broken session surfaces errors on real queries.
      });
    });

    // Decrement the cross-pool client count when a client is destroyed, so the
    // next 0→1 connect re-runs the session cleanup, and drop the client from
    // the live-client eviction registry (belt-and-suspenders next to the
    // client's own 'end' hook — pg-pool can destroy a client without a
    // graceful 'end' on exotic paths).
    this.on('remove', (client) => {
      /* v8 ignore next — every client pg removes fired 'connect' first, which wrote the entry; ?? 1 is a defensive default */
      const count = liveClientCounts.get(resolvedPglite) ?? 1;
      liveClientCounts.set(resolvedPglite, Math.max(0, count - 1));
      (client as unknown as PgBridgeClient).deregisterLiveClient();
    });

    // A client released with a suspended portal still open (an unclosed
    // pg-cursor) will never produce the terminating Sync that frees its
    // portal-suspension hold on the session lock — other clients would
    // block forever. The abandoned portal is dead either way; drop the
    // hold at release time.
    this.on('release', (_err, client) => {
      (client as unknown as PgBridgeClient).releaseAbandonedPortalHold();
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
    // Release the shared-instance slot synchronously: once end() is called
    // the pool accepts no new connections, so it can no longer run
    // connect-time cleanup against the session and stops counting toward
    // the concurrent-pool hazard immediately. Synchronous release also lets
    // PGliteBridge's constructor-failure path free the slot before it
    // rethrows (it cannot await).
    this.#releaseLiveSlot();
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

  #liveSlotReleased = false;

  /** Decrement this pool's slot in the shared-instance counter exactly once.
   *  end() calls this synchronously before pg-pool rejects a repeated end()
   *  — promise and callback form alike — so without the guard a double
   *  end() would double-decrement the counter and understate later
   *  concurrent-pool overlap. */
  #releaseLiveSlot(): void {
    if (this.#liveSlotReleased) return;
    this.#liveSlotReleased = true;
    const count = livePoolCounts.get(this.pglite) as number;
    livePoolCounts.set(this.pglite, count - 1);
  }
}
