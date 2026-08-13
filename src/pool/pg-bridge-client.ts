import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteDuplex } from '../duplex';
import { PgBridgeError } from '../errors.ts';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import type { SessionLock } from '../utils/session-lock.ts';
import { createStatementNameGenerator } from '../utils/statement-names.ts';
import type { BridgeWarningType } from '../warnings.ts';
import { decodeStatementCacheInvalidation, type StatementCacheInvalidation } from './deallocate.ts';
import { isObject, isTypesLike, wrapTypesWithFastArrayParsers } from './fast-array-parsers.ts';
import { FastQuery, type FastQueryField, type FastQueryResult } from './fast-query.ts';
import { assertPgInternals, getPgActiveQuery } from './pg-internals.ts';
import type { QueryTrailHandle, QueryTrailRecorder } from './query-trail.ts';
import { liveClients } from './session-registry.ts';

export interface PgBridgeClientOptions {
  pglite: PGlite | PGliteInterface;
  bridgeId: symbol;
  sessionLock?: SessionLock;
  telemetry?: TelemetrySink;
  syncToFs: boolean;
  timeout?: number;
  /** Forwarded to {@link PGliteDuplex}; see PGliteDuplexOptions.protocolCleanupNeeded. */
  protocolCleanupNeeded?: boolean;
  /** See PgBridgePoolOptions.fastQueryPath. Default `true`. */
  fastQueryPath?: boolean;
  /**
   * Cache query plans by injecting a stable name into unnamed cacheable DML
   * queries so PGlite caches the plan via the Extended Query Protocol. pg
   * skips the Parse message on repeat calls once the statement name is in
   * `connection.parsedStatements`. The client creates its own gated LRU
   * generator — a text is named on its second sighting, the
   * least-recently-used name is evicted at capacity and freed with a wire
   * `Close('S')` piggybacked onto the next submission — with names
   * `ppb_<namespace>_<seq>` under a process-unique namespace per client, so
   * names from different clients (or client generations) never collide in
   * the shared PGlite session. The object form overrides capacity/gate for
   * tests; it is not surfaced on the pool options. See
   * PgBridgePoolOptions.statementCaching.
   */
  statementCaching?: boolean | { capacity?: number; minUsages?: number };
  /**
   * Invoked synchronously inside the stream factory — while `super()` runs,
   * before any connect attempt and before construction can still fail — with
   * the fresh duplex's teardown handle. Must not throw: it runs inside pg's
   * Connection constructor, where a throw would leak the created duplex.
   */
  onTeardownCreated?: (teardown: DuplexTeardown) => void;

  /**
   * Pool-owned on-failure query trail. When present, this client registers a
   * stable ordinal at construction and captures every `query()` submission at
   * the SQL boundary (design: .claude/plans/query-trail-design.md §4). Absent
   * when the `queryTrail` option is off or the env kill switch disabled it —
   * capture then costs nothing.
   */
  queryTrail?: QueryTrailRecorder;
}

/** Duplex-teardown handle: `settled` is the duplex's resolve-only `onClose`
 *  (never rejects — `PgBridgePool.end()`'s Promise.all barrier relies on
 *  that), `abort` force-destroys a straggler. */
export type DuplexTeardown = {
  settled: Promise<void>;
  abort: (reason: Error) => void;
};

type PgBridgeClientConfig = pg.ClientConfig & {
  [PgBridgeClient.OptionsKey]: PgBridgeClientOptions;
};

/** Mirrors stock pg's Submittable probe (`typeof config.submit === 'function'`,
 *  which boxes primitives). Callers pre-exclude null/undefined — the dispatch
 *  in {@link PgBridgeClient.query} returns those to pg first. */
const isSubmittable = (value: unknown): value is pg.Submittable =>
  typeof (value as { submit?: unknown }).submit === 'function';

type QueryCallback = (err: unknown, res: unknown) => void;
/** pg's own contract: any function in the callback slot IS the callback —
 *  the predicate asserts the signature the same way pg does, centralizing
 *  what were two inline casts. */
const isQueryCallback = (value: unknown): value is QueryCallback => typeof value === 'function';

const QUERY_READ_TIMEOUT_MESSAGE = 'Query read timeout';

type QueryTimeout = {
  error: Error;
  rejection: Promise<never>;
  hasFired: () => boolean;
  clear: () => void;
};

/** Mirrors stock pg's readTimeout handling: pg forwards the user-supplied
 *  `query_timeout` value to `setTimeout` uncoerced (pg 8.22 client.js:664),
 *  so string values keep working there — `delay: unknown` plus the
 *  setTimeout-boundary cast below are deliberate parity, not a missing
 *  narrowing. */
const createQueryTimeout = (delay: unknown): QueryTimeout => {
  const error = new Error(QUERY_READ_TIMEOUT_MESSAGE);
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rejection = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      fired = true;
      timer = undefined;
      reject(error);
    }, delay as number);
  });
  const clear = (): void => {
    // Stryker disable next-line ConditionalExpression: accept — createQueryTimeout.clear guard `timer === undefined`→false: clearTimeout(undefined) is a documented no-op and timer is already undefined on the taken path, so the early return is unobservable; clear() is only reached post-settle where the timer has already fired-or-cleared.
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
  };
  return { error, rejection, hasFired: () => fired, clear };
};

/**
 * The exact runtime query-config fields pg 8.x consumes, in pg's own
 * consumption order. Sources of truth (verified against the installed
 * pg 8.22.0):
 *   - `pg/lib/query.js` `Query` constructor reads `text, values, rows, types,
 *     name, queryMode, binary, portal, callback, rowMode` (via `this.text =
 *     config.text` etc.); it reads `config.callback` a second time only when
 *     `process.domain` is set;
 *   - `pg/lib/client.js` (`Client.query`, ~line 660) reads `config.query_timeout`.
 * `query_timeout` is the sole Client-level addition beyond the Query
 * constructor's fields. Any pg update that starts consuming another config
 * property must be reflected here or the deferred bridge submission would
 * silently drop it — the A7 drift guard traces the complete stock
 * `Client.prototype.query` entry point through a successful live query and
 * fails the suite if the executed read set diverges from this list. pg's
 * leading `submit` dispatch probe is observed and asserted separately (the
 * bridge mirrors it in isSubmittable before snapshotting); it is never a
 * snapshot field. A runtime trace covers the executed successful path; a
 * read hidden behind an unexecuted upstream branch remains covered only by
 * the source citations above. Exported for that test only; it is NOT part
 * of the package's public surface (absent from src/index.ts). knip's
 * default config treats *.test.ts as entry files, so a test-only consumer
 * keeps this export "used".
 */
export const PG_CONSUMED_QUERY_FIELDS = [
  'text',
  'values',
  'rows',
  'types',
  'name',
  'queryMode',
  'binary',
  'portal',
  'callback',
  'rowMode',
  'query_timeout',
] as const;

/** The single config.callback discovery read, as consumed by the snapshot:
 *  `omit: true` means a callback was selected out-of-band (positional or
 *  config-embedded function) and the field must not resurface on the record;
 *  `omit: false` carries the captured non-function value so the snapshot never
 *  re-reads a possibly-accessor property. */
type CallbackCapture = { omit: true } | { omit: false; value: unknown };

/**
 * Snapshot a non-Submittable object query-config into an owned mutable plain
 * record, copying only the pg-consumed fields ({@link PG_CONSUMED_QUERY_FIELDS})
 * in pg's consumption order, reading each unshadowed field exactly once. This
 * reproduces stock pg's synchronous `new Query(config)` field capture so a
 * caller mutating the config after `query()` returns cannot change what the
 * deferred bridge submission (or the invalidation decoder) sees. Nested objects
 * (`values`, `types`, `callback`) are assigned by reference — no deep clone, no
 * freeze, no proxy. Unknown properties are never read, matching pg's Query
 * constructor.
 *
 * `valuesOverride` supplies a positional values array as the authoritative
 * `values` without reading a shadowed `config.values`. `callback` carries the
 * single discovery read: omit the field (a callback was selected out-of-band)
 * or inject the already-captured non-function value — never a second accessor
 * read.
 *
 * Exported for the A7 drift guard only (record keys must equal
 * {@link PG_CONSUMED_QUERY_FIELDS}); not part of the package's public surface.
 */
export const snapshotQueryConfig = (
  config: Record<string, unknown>,
  valuesOverride: { override: true; values: unknown[] } | { override: false },
  callback: CallbackCapture,
): Record<string, unknown> => {
  const record: Record<string, unknown> = {
    text: config.text,
    values: valuesOverride.override ? valuesOverride.values : config.values,
    rows: config.rows,
    types: config.types,
    name: config.name,
    queryMode: config.queryMode,
    binary: config.binary,
    portal: config.portal,
    // `callback` is positioned per pg's read order; its value comes from the
    // single discovery read (or is omitted) rather than a fresh accessor read.
    ...(callback.omit ? {} : { callback: callback.value }),
    rowMode: config.rowMode,
    query_timeout: config.query_timeout,
  };
  return record;
};

export class PgBridgeClient extends pg.Client {
  private querySubmissionChain?: Promise<void>;
  /** Live connection default hidden only while pg's own timer is suppressed;
   *  synchronous query() re-entry must still inherit the public default.
   *  Invariant: undefined outside a single execute()'s try/finally — the
   *  reservation (immediate path) and the chain's one-at-a-time .then hop
   *  (deferred path) make overlapping suppression frames impossible. */
  #suppressedConnectionQueryTimeout?: unknown;
  /** Result-field metadata per statement name, mirroring the lifetime of
   *  `connection.parsedStatements`: a recycled client starts both empty. */
  readonly #fieldsCache = new Map<string, FastQueryField[]>();
  readonly #fastQueryPath: boolean;
  /** This client's own name generator (client-unique namespace), or
   *  undefined when statement caching is off. */
  readonly #stmtNameGen?: (sql: string) => string | undefined;
  /** Names evicted by the generator's LRU, awaiting a wire `Close('S')`.
   *  Drained at the next submission point — the Close rides as a prefix of
   *  that query's message train (one PGlite call, zero dedicated round
   *  trips). Names are monotonic and never reused, so a Close that never
   *  drains (client ends first) only orphans one session-side statement. */
  readonly #pendingCloses: string[] = [];
  /** The backing PGlite instance — the key into the liveClients registry. */
  readonly #pglite: object;
  /** Latest duplex from the stream factory. Boxed because the factory
   *  closure is created inside the `super()` arguments, where `this` is
   *  not yet accessible. */
  readonly #duplexBox: { current?: PGliteDuplex };

  /** The pool-owned trail recorder, or undefined when the feature is off. */
  readonly #trail?: QueryTrailRecorder;
  /** This client's stable trail ordinal, assigned at construction when the
   *  trail is on. */
  readonly #trailClientId: number;

  static readonly OptionsKey: unique symbol = Symbol('PgBridgeClientOptions');

  constructor(config?: PgBridgeClientConfig) {
    if (!config?.[PgBridgeClient.OptionsKey]) {
      throw new PgBridgeError('BRIDGE_OPTIONS_REQUIRED', 'PgBridgeClient requires bridge options');
    }
    const { [PgBridgeClient.OptionsKey]: bridge, ...clientConfig } = config;

    const duplexBox: { current?: PGliteDuplex } = {};
    const caching = bridge.statementCaching;
    const features = {
      fastQueryPath: bridge.fastQueryPath ?? true,
      statementCaching: Boolean(caching),
    };
    super({
      ...clientConfig,
      user: 'postgres',
      database: 'postgres',
      stream: () => {
        const duplex = new PGliteDuplex(bridge.pglite, bridge);
        duplexBox.current = duplex;
        bridge.onTeardownCreated?.({
          settled: duplex.onClose,
          abort: (reason) => duplex.destroy(reason),
        });
        return duplex;
      },
    });
    try {
      assertPgInternals(this, features);
    } catch (error) {
      /* v8 ignore start -- pg 8.x invokes the supplied stream factory synchronously in super() */
      // Stryker disable next-line OptionalChaining: accept — `duplexBox.current?.destroy`→non-optional in the assertPgInternals catch: pg 8.x runs the stream factory synchronously in super(), so current is always set on this reachable arm (line is `/* v8 ignore */` for the undefined case); the `?.` guard is defensive-only and its removal changes nothing observable.
      duplexBox.current?.destroy();
      /* v8 ignore stop */
      throw error;
    }

    this.#duplexBox = duplexBox;
    this.#fastQueryPath = features.fastQueryPath;
    this.#pglite = bridge.pglite;
    this.#trail = bridge.queryTrail;
    // registerClient() only when the trail is on; -1 is never read otherwise.
    this.#trailClientId = bridge.queryTrail?.registerClient() ?? -1;
    this.#stmtNameGen = features.statementCaching
      ? createStatementNameGenerator({
          ...(typeof caching === 'object' ? caching : undefined),
          onEvict: (name) => this.#pendingCloses.push(name),
        })
      : undefined;

    // Register unconditionally — even a statementCaching: false client can
    // hold user-named statements in parsedStatements that need eviction when
    // a sibling issues a session-wide DEALLOCATE / DISCARD ALL.
    let clients = liveClients.get(bridge.pglite);
    if (clients === undefined) {
      clients = new Set();
      liveClients.set(bridge.pglite, clients);
    }
    clients.add(this);
    this.once('end', () => this.deregisterLiveClient());
  }

  /** Remove this client from the session-wide live-client registry. Invoked
   *  from the client's own 'end' event and, belt-and-suspenders, by
   *  `PgBridgePool`'s 'remove' listener — pg-pool can destroy a client
   *  without a graceful 'end' on exotic paths. Idempotent; the Set is
   *  dropped from the registry when it empties so it can be collected. */
  deregisterLiveClient(): void {
    const clients = liveClients.get(this.#pglite);
    if (clients === undefined) return;
    clients.delete(this);
    if (clients.size === 0) liveClients.delete(this.#pglite);
  }

  /** See {@link PGliteDuplex.releaseAbandonedPortalHold} — invoked by
   *  `PgBridgePool`'s `'release'` listener when this client returns to the
   *  pool. */
  releaseAbandonedPortalHold(): void {
    // Stryker disable next-line OptionalChaining: accept — `this.#duplexBox.current?.releaseAbandonedPortalHold`→non-optional: pg runs the stream factory synchronously in super(), so #duplexBox.current is always defined for a constructed client; the `?.` undefined arm is unreachable (same guarantee as the /* v8 ignore */ teardown guards) and its removal is unobservable.
    this.#duplexBox.current?.releaseAbandonedPortalHold();
  }

  /** Roll back a transaction left open when this client plain-releases (no
   *  COMMIT/ROLLBACK) — invoked by `PgBridgePool`'s `'release'` listener. On a
   *  shared PGlite session an abandoned transaction would otherwise keep the
   *  SessionLock owned (wedging every other pool client) and leak into the
   *  recycled client's next checkout. Cleanup is judged when the submission
   *  chain drains, not at release time — see the chained cleanup link below. */
  rollbackAbandonedTransaction(): void {
    // A released client whose active query is a bare Submittable with no
    // chained bridge-managed work behind it is wedged for good ONLY when no
    // suspended portal is recorded (e.g. a Submittable whose submit hung):
    // there, a chained ROLLBACK could never reach the wire — it would only
    // sit queued until teardown and then arm a destroy-time race against a
    // closing PGlite (the dead-WASM event-loop spin). Skip silently — the
    // destroy-time rollbackIfInTransaction goes through pglite.query
    // directly, bypassing pg's queue, and remains the backstop. A SUSPENDED
    // PORTAL is recoverable and must fall through: releaseAbandonedPortalHold
    // (which ran just before this in the same pool 'release' listener)
    // delivers the recovery Sync that completes the abandoned cursor, so
    // pg's queue unblocks and a cleanup link CAN drain — that is what closes
    // the former composite-window wedge.
    if (
      getPgActiveQuery(this) != null &&
      this.querySubmissionChain === undefined &&
      // Stryker disable next-line OptionalChaining: accept — `this.#duplexBox.current?.hasSuspendedPortal`→non-optional: #duplexBox.current is always defined post-construction (stream factory runs synchronously in super()), so the `?.` undefined arm is unreachable; removal is unobservable.
      this.#duplexBox.current?.hasSuspendedPortal() !== true
    ) {
      return;
    }
    // Idle client outside a transaction: nothing abandoned. This also covers
    // the non-transactional abandoned cursor (the delivered recovery Sync
    // closes its implicit transaction; no cleanup needed). A client WITH
    // chained work is deliberately not screened on inTransaction here — the
    // verdict belongs to AFTER that work settles (an unawaited BEGIN opens
    // a transaction, an unawaited COMMIT closes one), so the cleanup link
    // re-checks when it runs — which is also why a user-queued COMMIT tail
    // legitimately wins over the cleanup: the re-check finds the transaction
    // closed and no-ops silently.
    // Stryker disable next-line OptionalChaining: accept — `this.#duplexBox.current?.inTransaction`→non-optional: #duplexBox.current is always defined post-construction (stream factory runs synchronously in super()), so the `?.` undefined arm is unreachable; removal is unobservable.
    if (this.querySubmissionChain === undefined && !this.#duplexBox.current?.inTransaction) {
      return;
    }
    this.#chainRollbackCleanup();
  }

  /**
   * Register the abandoned-transaction cleanup as an explicit link on the
   * submission chain. Invariants: the link is registered SYNCHRONOUSLY here
   * — pg-pool emits 'release' before the client joins the idle set, so the
   * link (and any ROLLBACK it issues) is ordered ahead of every
   * next-checkout query — and the link's chain tail releases only after
   * that ROLLBACK has settled, never between enqueue and settle. State is
   * judged when the link RUNS, not at registration: an unawaited in-flight
   * COMMIT/ROLLBACK has closed the transaction by then (silent no-op, no
   * spurious warning), an unawaited BEGIN has opened one (rolled back), and
   * a duplex already torn down hands off to _destroy's
   * rollbackIfInTransaction backstop.
   */
  #chainRollbackCleanup(): void {
    const prior = this.querySubmissionChain ?? Promise.resolve();
    const cleanup = (): Promise<void> => {
      const duplex = this.#duplexBox.current;
      /* v8 ignore start — a release-registered link implies the stream factory ran */
      // Stryker disable next-line ConditionalExpression: accept — `duplex === undefined`→false inside the cleanup link: a release-registered link implies the stream factory ran (line is `/* v8 ignore */`), so current is always defined when the link runs; removing the guard is unobservable on every reachable path.
      if (duplex === undefined) return Promise.resolve();
      /* v8 ignore stop */
      // Teardown won the race (or the in-flight query died with its
      // connection): the duplex _destroy path already rolls back. And a
      // transaction closed by the in-flight work itself needs no cleanup.
      if (duplex.destroyed || !duplex.inTransaction) return Promise.resolve();
      process.emitWarning(
        'A pool client was released with an open transaction; attempting ROLLBACK. ' +
          'Commit or roll back before release().',
        { type: 'PGliteBridgeAbandonedTransactionWarning' satisfies BridgeWarningType },
      );
      // super.query, not this.query: re-entering query() from a chain link
      // would chain onto the link's own unsettled tail and deadlock. A bare
      // ROLLBACK needs none of query()'s added services (no statement
      // naming, no dealloc intercept, no fast path).
      return super.query('ROLLBACK').then(
        () => undefined,
        // Stryker disable next-line BlockStatement: accept — the ROLLBACK-rejection recovery block →`{}`: `/* v8 ignore */` defensive arm — pg's bare `super.query('ROLLBACK')` on a live abandoned tx does not reject in the test-reachable path, so the destroy-on-rollback-failure branch has no deterministic driver through the public API; unobservable without stubbing pg's ROLLBACK to reject, which is an internal seam not a behavior.
        (err: unknown) => {
          // The ROLLBACK failing means the connection itself is broken — a
          // plain swallow would park a dirty client in pg-pool's idle set
          // with the session lock possibly still held. Destroy the duplex
          // instead: its _destroy path (rollbackIfInTransaction + lock
          // cancel) is the authoritative backstop, and pg-pool's idle
          // 'error' listener removes the dead client from the pool.
          /* v8 ignore start — defensive arm: pg rejects with Error instances, and the duplex outlives its client */
          // Stryker disable next-line OptionalChaining: accept — `this.#duplexBox.current?.destroy`→non-optional inside the same `/* v8 ignore */` ROLLBACK-failure arm as 2068: unreachable deterministically; accept for the same reason.
          this.#duplexBox.current?.destroy(err instanceof Error ? err : new Error(String(err)));
          /* v8 ignore stop */
        },
      );
    };
    let chainTail: Promise<void>;
    const releaseChainTail = (): void => {
      if (this.querySubmissionChain === chainTail) this.querySubmissionChain = undefined;
    };
    chainTail = prior.then(cleanup).then(releaseChainTail, releaseChainTail);
    this.querySubmissionChain = chainTail;
  }

  /** Duplex-teardown handle for `PgBridgePool.end()`'s close barrier:
   *  `settled` resolves once the duplex has fully torn down — after the
   *  awaited `_destroy`/`_final` rollback, so no PGlite call from this
   *  client can still be in flight — and `abort` force-destroys a
   *  straggling duplex when the barrier's drain bound expires. Settled
   *  immediately when the stream factory never ran (client never
   *  connected). */
  get teardown(): DuplexTeardown {
    const duplex = this.#duplexBox.current;
    return {
      /* v8 ignore start — pg runs the stream factory synchronously in super(), so a constructed client always has a duplex */
      // Stryker disable next-line OptionalChaining: accept — `duplex?.onClose`→non-optional in the teardown getter: `/* v8 ignore */` — pg runs the stream factory synchronously in super() so a constructed client always has a duplex; the `?.` undefined arm is unreachable post-construction.
      settled: duplex?.onClose ?? Promise.resolve(),
      /* v8 ignore stop */
      /* v8 ignore start — same guarantee: the `?.` undefined arm is unreachable post-construction */
      // Stryker disable next-line OptionalChaining: accept — `duplex?.destroy`→non-optional in the teardown getter's abort: same `/* v8 ignore */` guarantee as 2077 — the undefined arm is unreachable post-construction.
      abort: (reason) => duplex?.destroy(reason),
      /* v8 ignore stop */
    };
  }

  /**
   * Dispatch order: null/undefined go straight to stock pg; Submittables
   * return synchronously with their ADMISSION deferred behind the
   * submission chain (call order preserved, completion untracked); the
   * callback forms — positional or config-embedded, last positional winning
   * like pg's normalizeQueryConfig — re-enter as a promise and return
   * `undefined`; remaining object-form queries are snapshotted into an owned
   * record (stock pg's call-time `new Query(config)` capture), then get `types`
   * wrapped with fast-array parsers, then run either the FastQuery fast path or
   * stock pg — both serialized on one submission chain so mixed-path call order
   * cannot invert.
   */
  // `any` is irreducible here. The honest union of the three real return
  // shapes — `Promise<unknown> | pg.Submittable | undefined` — was attempted
  // (2026-07-17) and rejected: return positions are covariant, so an
  // override must be a subtype of EVERY base overload's return
  // (`Promise<QueryArrayResult>`, `T extends Submittable`, …), which no
  // honest union satisfies; the mismatch then cascades into consumer
  // assignability (`PoolConfig.Client` rejects the class). Only `any`
  // inhabits the whole overload set.
  // biome-ignore lint/suspicious/noExplicitAny: satisfy pg.Client.query's overload union
  override query(...args: unknown[]): any {
    const first = args[0];
    // Forward the config/text (and the rejected null/undefined) shapes to stock
    // pg. TypeScript cannot spread `args: unknown[]` across pg.query's overload
    // set, so a single-signature view is unavoidable — but every shape routed
    // here returns a promise or throws before returning, so the view is honest.
    const submitStock = (): Promise<unknown> =>
      (super.query as (...a: unknown[]) => Promise<unknown>).apply(this, args);

    // Preserve pg's synchronous TypeError for null/undefined query.
    if (first === null || first === undefined) return submitStock();

    // Submittable: pg's contract returns the argument itself, synchronously,
    // and pg's internal queue provides FIFO execution once admitted. Only
    // ADMISSION (the super.query call) is serialized behind the submission
    // chain, so a Submittable cannot jump ahead of a chained pending query;
    // the chain is NOT extended past it — arbitrary Submittables expose no
    // uniform terminal signal, so ordering relative to its COMPLETION stays
    // pg's business (admission order, not completion order). A later
    // ordinary query chains onto the same prior, and `.then` callbacks on
    // one promise run in registration order, so pg's queue still receives
    // both in call order. adapter-pg never uses this form; users mixing
    // Submittable + promise forms on one client may still trip the pg queue
    // deprecation.
    if (isSubmittable(first)) {
      // Capture passively: read the Submittable's `.text` (a text-bearing
      // pg.Query) or tag an opaque one `<submittable:ClassName>`, and settle
      // off its own `end`/`error` channels — never altering pg's dispatch.
      this.#trailBeginSubmittable(first);
      // Forward the FULL argument list: stock pg's submittable arm attaches a
      // trailing positional callback to the query itself (`if (!query.callback)
      // query.callback = ...`), which is how pg-pool's release callback reaches
      // a pool.query(Submittable) — dropping it wedged the pool client forever.
      // (Not submitStock: stock returns the submittable here, not a promise.)
      const admit = (): void => {
        // `void` discards the returned Submittable only — a synchronous
        // submit throw still propagates to the recovery paths.
        void (super.query as (...a: unknown[]) => unknown).apply(this, args);
        // Only after a successful admission: a throwing submit takes the
        // recovery paths below and must never arm eviction.
        this.#armSubmittableDeallocEviction(first);
      };
      const prior = this.querySubmissionChain;
      if (prior === undefined) {
        admit();
      } else {
        // `prior` is a chain tail and never rejects (both settle arms release it).
        void prior.then(() => {
          try {
            admit();
          } catch (err) {
            // A submit() that throws mid-pulse violates pg's Submittable
            // contract and leaves the client wedged: pg has already set its
            // active-query slot and cleared readyForQuery, nothing is on
            // the wire to unwedge it, and every successor queues forever.
            // Stock pg at least throws synchronously to query()'s caller;
            // this deferred hop has no caller, so a silent wedge would be
            // strictly worse (probe-verified against pg 8.22). Destroy the
            // duplex: pg's connection-error path errors the active query
            // (this Submittable) and everything queued behind it — exactly
            // once each, through handleError, pg's canonical delivery — and
            // pg-pool evicts the dead client. (A Submittable WITHOUT
            // handleError crashes in that delivery — pg's own runtime
            // contract, identical to stock pg erroring such an object.)
            // Stryker disable next-line OptionalChaining: accept — `this.#duplexBox.current?.destroy`→non-optional in the deferred-submit-throws recovery: this arm runs only on a connected client (the stream factory ran), where current is always defined, so the `?.` undefined arm is unreachable and its removal is unobservable.
            this.#duplexBox.current?.destroy(err instanceof Error ? err : new Error(String(err)));
          }
        });
      }
      return first;
    }

    // pg's query(config, values, callback) collapses positional functions and
    // a config-embedded `callback` into one slot (last positional wins).
    // Discover the callback ONCE here so both the callback re-entry and the
    // ordinary snapshot below share the single read (an accessor-backed
    // `config.callback` must never be evaluated twice, and a shadowed one must
    // not be evaluated at all).
    const discovery = this.#discoverCallback(args, first);
    // Handle every callback form, then return `undefined` like stock pg does
    // in callback mode.
    if (this.#dispatchCallbackForm(args, first, discovery)) return undefined;
    // Callback forms re-enter this.query() with an owned snapshot, so they are
    // captured there — only the promise/fast paths capture here. Read the SQL
    // and values NOW, before the snapshot below rewrites args[0]: a positional
    // values array wins over a config's own `values`, matching pg's override.
    const trailHandle = this.#trailBeginOrdinary(first, args[1]);

    // From here on, non-Submittable object configs are snapshotted into an
    // owned mutable record (stock pg's call-time `new Query(config)` capture),
    // and every later transformation — types wrapping, name injection,
    // invalidation decoding, fast-path selection, deferred submission — reads
    // that owned record. A caller mutating the original config after query()
    // returns therefore cannot change which text is submitted or decoded.
    if (isObject(first)) {
      // A positional array is the authoritative `values` override, applied
      // before any fast-path decision and without reading a shadowed
      // config.values. Non-array trailing shapes keep today's behavior (they
      // still disqualify FastQuery via the args.length/Array checks).
      const valuesOverride: { override: true; values: unknown[] } | { override: false } =
        Array.isArray(args[1]) ? { override: true, values: args[1] } : { override: false };
      // Every callback-selecting shape dispatched and returned above, so here
      // the capture is always the completed config.callback read. Copy that
      // captured value into the snapshot (never a function on this path: a
      // function would have fired the callback dispatch).
      args[0] = snapshotQueryConfig(first, valuesOverride, discovery.capture);
    }

    if (isObject(args[0]) && isTypesLike(args[0].types)) {
      // Wrap the owned record's `types` in place — no second clone.
      args[0].types = wrapTypesWithFastArrayParsers(args[0].types);
    }

    // String-form parameterized queries run the extended protocol with an
    // unnamed statement — the same re-parse cost as object form — so
    // normalize them into config form for the injection below
    // (normalizeQueryConfig treats `query(text, values)` and
    // `query({ text }, values)` identically). Empty values arrays stay
    // string-form: pg runs those on the simple protocol
    // (requiresPreparation checks values.length), and a name would flip
    // the protocol.
    if (
      this.#stmtNameGen &&
      typeof first === 'string' &&
      Array.isArray(args[1]) &&
      args[1].length > 0
    ) {
      args[0] = { text: first };
    }

    // Inject a stable name into unnamed cacheable DML so PGlite caches the
    // query plan via EQP. pg skips Parse on repeat calls for named statements
    // (connection.parsedStatements guard in Query.prepare). Submittable queries
    // are already dispatched above; parameterless string-form queries stay on
    // the simple protocol via the isObject guard below. Empty text is never
    // named — CACHEABLE_SQL requires a leading statement keyword, and that
    // regex (not this guard) is the layer keeping empty text unnamed like
    // stock pg runs it. The record is owned, so the name is injected in place.
    if (this.#stmtNameGen && isObject(args[0])) {
      const queryConfig = args[0] as Record<string, unknown>;
      if (typeof queryConfig.text === 'string' && queryConfig.name == null) {
        const name = this.#stmtNameGen(queryConfig.text);
        if (name !== undefined) queryConfig.name = name;
      }
    }

    // Detect DEALLOCATE before submitting so we can sync pg's plan cache
    // with PGlite after the statement resolves. Decode from the ONE captured
    // text (the owned record's, or the immutable string form) — the same value
    // the backend eventually submits.
    const dealloc = this.#detectStatementCacheInvalidation(args[0]);

    // The fast path rides the SAME submission chain as stock object-form
    // queries — a FastQuery must never jump ahead of a chained pending
    // stock query, or mixed-path call order would invert.
    const submitFn = this.#fastSubmit(args) ?? submitStock;
    const submitWithCloses = () => {
      // Drain evicted-name Closes as a prefix of this query's message
      // train — including an eviction this very call's promotion queued.
      if (this.#pendingCloses.length > 0) this.#flushPendingCloses();
      return submitFn();
    };

    const prior = this.querySubmissionChain;
    // Synchronous hooks such as toPostgres and a warm getTypeParser can re-enter
    // before the ordinary tail below is registered. Publish a reservation first;
    // its identity clear preserves any successor installed by the reentrant call.
    const reservation = prior === undefined ? Promise.withResolvers<void>() : undefined;
    if (reservation !== undefined) {
      const reservationTail = reservation.promise.then(() => {
        if (this.querySubmissionChain === reservationTail) this.querySubmissionChain = undefined;
      });
      this.querySubmissionChain = reservationTail;
    }
    // Every object form was replaced above by snapshotQueryConfig's fresh,
    // mutable plain record. This is never the caller's object (which may be
    // frozen); only this owned snapshot is suppressed around stock admission.
    const ownedConfig = isObject(args[0]) ? args[0] : undefined;
    // Declared in the pg-internals seam and verified at construction: stock
    // pg reads this object for every query's timeout (pg 8.22 client.js:660)
    // and the suppression frame below mutates it.
    const connectionParameters = this.connectionParameters;
    // Sample before execute: submitWithCloses can synchronously re-enter query()
    // only after execute publishes the saved default; deferring this read would
    // lose that call-time inheritance once the queued nested execute runs.
    const effectiveQueryTimeout =
      ownedConfig?.query_timeout ||
      connectionParameters.query_timeout ||
      this.#suppressedConnectionQueryTimeout;
    const timeout = effectiveQueryTimeout ? createQueryTimeout(effectiveQueryTimeout) : undefined;
    const execute = (): Promise<unknown> => {
      if (timeout?.hasFired()) return Promise.reject(timeout.error);
      if (timeout === undefined) return submitWithCloses();

      const perQueryTimeout = ownedConfig?.query_timeout;
      if (ownedConfig !== undefined) ownedConfig.query_timeout = 0;
      const connectionTimeout = connectionParameters.query_timeout;
      // The reservation makes nested managed execution impossible on the
      // immediate path; on the deferred path execute() runs as the chain's
      // one-at-a-time .then microtask, after every prior frame unwound.
      // Either way one suppression frame suffices — no stack.
      this.#suppressedConnectionQueryTimeout = connectionTimeout;
      connectionParameters.query_timeout = 0;
      try {
        return submitWithCloses();
      } finally {
        if (ownedConfig !== undefined) ownedConfig.query_timeout = perQueryTimeout;
        connectionParameters.query_timeout = connectionTimeout;
        this.#suppressedConnectionQueryTimeout = undefined;
      }
    };

    let rawQueryPromise: Promise<unknown>;
    if (prior === undefined) {
      try {
        rawQueryPromise = execute();
      } catch (err) {
        rawQueryPromise = Promise.reject(err);
      }
    } else {
      rawQueryPromise = prior.then(execute);
    }

    // After PGlite confirms a DEALLOCATE / DISCARD ALL, evict matching entries
    // from pg's parsedStatements (the skip-Parse guard) and #fieldsCache on
    // EVERY live client of this PGlite instance — the session-wide wipe
    // invalidates names any of them may hold, not just the issuer's. Without
    // this, a sibling would skip Parse for a name PGlite forgot and fail its
    // next Bind with Postgres error 26000.
    const executionPromise =
      dealloc === null
        ? rawQueryPromise
        : rawQueryPromise.then((result: unknown) => {
            this.#evictStatementCachesEverywhere(dealloc);
            return result;
          });

    // Settle the trail entry off the real completion — a passive observer that
    // never touches what the caller receives (publicPromise, possibly a
    // timeout race). Off executionPromise, not the raced promise, so rowCount
    // reflects the actual result.
    if (trailHandle !== undefined) {
      void executionPromise.then(
        (result: unknown) =>
          trailHandle.settle({ rowCount: (result as { rowCount?: number | null })?.rowCount }),
        (error: unknown) => trailHandle.settle({ error }),
      );
    }

    if (timeout !== undefined) {
      void executionPromise.then(timeout.clear, timeout.clear);
    }
    const publicPromise =
      timeout === undefined
        ? executionPromise
        : Promise.race([executionPromise, timeout.rejection]);

    if (reservation !== undefined) {
      void executionPromise.then(
        () => reservation.resolve(),
        () => reservation.resolve(),
      );
      return publicPromise;
    }

    // Register this query's tail on the submission chain; each query clears
    // only its own slot (identity check) so concurrent queries never stomp.
    let chainTail: Promise<void>;
    const releaseChainTail = () => {
      if (this.querySubmissionChain === chainTail) {
        this.querySubmissionChain = undefined;
      }
    };
    chainTail = executionPromise.then(releaseChainTail, releaseChainTail);
    this.querySubmissionChain = chainTail;
    return publicPromise;
  }

  /** Discover pg's single callback slot ONCE: the last positional function
   *  after the first argument wins; only when none exists is an object config's
   *  `callback` read (exactly once — it may be an accessor). `retained` is the
   *  non-function positional arguments, in order, for callback re-entry. The
   *  `capture` mirrors that single read for {@link snapshotQueryConfig} on the
   *  ordinary promise path so no field is re-evaluated. */
  #discoverCallback(
    args: unknown[],
    first: unknown,
  ): {
    callback: ((err: unknown, res: unknown) => void) | undefined;
    retained: unknown[];
    capture: CallbackCapture;
  } {
    const retained: unknown[] = [];
    let positionalCb: ((err: unknown, res: unknown) => void) | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (isQueryCallback(arg)) {
        positionalCb = arg;
      } else {
        retained.push(arg);
      }
    }
    if (positionalCb !== undefined) {
      // A positional callback shadows any config.callback — pg overwrites it —
      // so config.callback is never read, and the ordinary snapshot (which the
      // dispatch will skip anyway) omits it.
      return { callback: positionalCb, retained, capture: { omit: true } };
    }
    if (!isObject(first)) {
      // A non-object first argument is never snapshotted, so this capture is
      // never consumed; `omit` keeps the type total without a dead read arm.
      return { callback: undefined, retained, capture: { omit: true } };
    }
    // Single read of a possibly-accessor config.callback.
    const configCb = first.callback;
    if (isQueryCallback(configCb)) {
      // The selected callback is omitted from the re-entry snapshot; pg would
      // overwrite it with the positional callback we synthesize on re-entry.
      return { callback: configCb, retained, capture: { omit: true } };
    }
    // A captured non-function callback value is injected into the ordinary
    // snapshot from this one read (stripped-then-re-copied, matching pg keeping
    // a non-function `callback` on the config for its own later rejection).
    return { callback: undefined, retained, capture: { omit: false, value: configCb } };
  }

  /** Handle the callback forms of `query()` using the shared {@link
   *  #discoverCallback} result: re-enters as a promise with an OWNED snapshot
   *  record (callback omitted, built inside the try so a throwing other-known
   *  field getter is delivered to the callback) and retained positional
   *  arguments, then invokes the callback. Returns `true` when a callback
   *  fired (the caller returns `undefined` like stock pg in callback mode),
   *  `false` when there is none. */
  #dispatchCallbackForm(
    args: unknown[],
    first: unknown,
    discovery: {
      callback: ((err: unknown, res: unknown) => void) | undefined;
      retained: unknown[];
      capture: CallbackCapture;
    },
  ): boolean {
    const cb = discovery.callback;
    if (cb === undefined) return false;

    try {
      // For an object config, snapshot it with the callback omitted rather than
      // spreading it (a `{ callback, ...rest }` rest-spread would evaluate every
      // unrelated enumerable getter). A positional-array values override applies
      // here too. Building inside this try delivers a throwing other-known field
      // getter to the callback, not to the synchronous caller. A string first
      // argument needs no snapshot (immutable).
      const valuesOverride: { override: true; values: unknown[] } | { override: false } =
        Array.isArray(args[1]) ? { override: true, values: args[1] } : { override: false };
      const reentryFirst = isObject(first)
        ? snapshotQueryConfig(first, valuesOverride, { omit: true })
        : first;
      const invokeCallback = (err: unknown, res: unknown): void => {
        try {
          cb(err, res);
        } catch (callbackError) {
          // Escape the promise reaction so a callback throw uses pg 8.22's
          // uncaughtException channel instead of becoming an unhandled rejection.
          /* v8 ignore next 3 — exercised by the subprocess callback-channel probe */
          process.nextTick(() => {
            throw callbackError;
          });
        }
      };
      this.query(reentryFirst, ...discovery.retained).then(
        (res: unknown) => invokeCallback(null, res),
        (err: unknown) => invokeCallback(err, undefined),
      );
    } catch (err) {
      // Intentionally bypass invokeCallback: snapshot/known-field getter failures
      // happen during query() dispatch, so callback throws here remain synchronous.
      cb(err, undefined);
    }
    return true;
  }

  /** Returns the eviction scope if the OWNED query record (or immutable string
   *  form) describes a DEALLOCATE or DISCARD ALL statement, `null` otherwise.
   *  Takes the config already captured by {@link query} — one text identity per
   *  call — so the decoded scope and the submitted text can never diverge.
   *  Handles both string form (`query('DEALLOCATE ALL')`) and object form
   *  (`query({ text: 'DEALLOCATE ALL' })`); the lexical contract — supported
   *  identifier forms, ASCII-only folding, fail-closed exclusions — lives in
   *  {@link decodeStatementCacheInvalidation}'s module. */
  #detectStatementCacheInvalidation(config: unknown): StatementCacheInvalidation | null {
    const text =
      typeof config === 'string'
        ? config
        : isObject(config) && typeof config.text === 'string'
          ? config.text
          : null;
    if (!text) return null;
    return decodeStatementCacheInvalidation(text);
  }

  /** Evict statement entries from pg's internal parsedStatements map and from
   *  #fieldsCache after a confirmed DEALLOCATE / DISCARD ALL. pg uses
   *  parsedStatements to skip the Parse message on repeat named-statement
   *  calls; if PGlite's copy is gone but pg's is not, the next Bind fails with
   *  Postgres error 26000. #fieldsCache mirrors parsedStatements' lifetime per
   *  its own comment. Scope: this client only — session-wide propagation is
   *  the caller's job (the dealloc intercept in query() iterates the
   *  liveClients registry). */
  #clearStatementCaches(scope: StatementCacheInvalidation): void {
    const ps = this.connection.parsedStatements;
    if ('all' in scope) {
      for (const key of Object.keys(ps)) delete ps[key];
      this.#fieldsCache.clear();
    } else {
      delete ps[scope.name];
      this.#fieldsCache.delete(scope.name);
    }
  }

  /** Session-wide eviction after a confirmed DEALLOCATE / DISCARD ALL: the
   *  backend wipe invalidates names ANY live client of this PGlite may hold,
   *  not just the issuer's. */
  #evictStatementCachesEverywhere(scope: StatementCacheInvalidation): void {
    const clients = liveClients.get(this.#pglite);
    /* v8 ignore next — the issuer stays registered until 'end'; a dealloc resolving after teardown is unreachable through the pool */
    if (clients !== undefined) {
      for (const client of clients) client.#clearStatementCaches(scope);
    }
  }

  /** DEALLOCATE / DISCARD through a Submittable must evict the same caches
   *  the plain-text path does, but the submission chain deliberately ends at
   *  Submittables, so completion is observed through pg's own channels. Both
   *  are armed behind one exactly-once guard because pg invokes
   *  `query.callback` AND then unconditionally emits 'end' on success
   *  (pg 8.22 lib/query.js handleReadyForQuery). The wrapped callback covers
   *  pg-pool's release path; 'end' covers a fired query_timeout, where pg
   *  noop-replaces the callback but 'end' still emits at REAL completion —
   *  matching the plain path's evict-on-real-completion (it chains on the
   *  raw promise, not the timeout race). Errors evict nothing: pg calls
   *  callback(err) XOR emits 'error', and 'end' is not emitted. Fail-closed
   *  like the plain path's lexical exclusions: an unreadable/undetectable
   *  text or a Submittable exposing neither channel skips silently (the SQL
   *  runs unchanged; only local eviction is skipped — documented in
   *  PgBridgePoolOptions.statementCaching). A frozen Submittable skips the
   *  same way, and must be REJECTED UP FRONT, not attempted-and-caught:
   *  node's once() attaches the listener to the (unfrozen) _events record
   *  BEFORE its ++_eventsCount write throws, so a caught attempt leaves a
   *  half-attached listener whose removal detonates inside pg's own
   *  emit('end') at completion and wedges the connection. Stock pg itself
   *  completes a frozen Submittable cleanly (its callback assign is guarded
   *  by `if (!query.callback)`; an emit with no listeners mutates nothing),
   *  and arming must never throw after a successful admission. */
  #armSubmittableDeallocEviction(submittable: unknown): void {
    let scope: StatementCacheInvalidation | null;
    try {
      scope = this.#detectStatementCacheInvalidation(submittable);
    } catch {
      // Stock pg never reads `.text` during query() for Submittables; a
      // throwing accessor must not make the bridge throw where stock doesn't.
      return;
    }
    if (scope === null) return;
    // See the frozen-Submittable note in the jsdoc: neither channel can be
    // armed safely, and a caught once() attempt would plant a half-attached
    // listener. Skip before touching the object.
    if (Object.isFrozen(submittable)) return;

    let evicted = false;
    const evict = (): void => {
      if (evicted) return;
      evicted = true;
      this.#evictStatementCachesEverywhere(scope);
    };

    const target = submittable as { callback?: unknown; once?: unknown };
    const original = target.callback;
    if (typeof original === 'function') {
      const wrapped = (err: unknown, res: unknown): void => {
        // Delegation is unconditional (finally): an eviction failure must
        // never swallow pg-pool's release callback and leak the client.
        try {
          if (err == null) evict();
        } finally {
          // pg invokes query.callback on the query itself; preserve that.
          (original as (...a: unknown[]) => void).call(submittable, err, res);
        }
      };
      try {
        target.callback = wrapped;
      } catch {
        // Non-writable slot (defineProperty) on an unfrozen object — the
        // assignment leaves no partial state; the 'end' arm below may still
        // evict.
      }
    }
    if (typeof target.once === 'function') {
      try {
        (target.once as (event: string, listener: () => void) => void).call(
          submittable,
          'end',
          evict,
        );
      } catch {
        // A hostile once() override — fail closed, same doctrine as the
        // detection catch. (The frozen case, where node's own once() throws
        // half-attached, never reaches here.)
      }
    }
  }

  /** Drain queued evicted names: free each server-side statement with a
   *  wire `Close('S', name)` written immediately before the imminent
   *  query's message train — the duplex pipelines both into one
   *  Sync-terminated batch, so eviction costs no dedicated round trip, and
   *  pg parses the resulting CloseComplete but attaches no Client listener,
   *  so it is dropped. Also drops pg's parse-skip entry and the fields
   *  cache so client-side books can't accumulate names that no longer
   *  exist server-side. Safe in a failed transaction: Close is
   *  session-level, processed even while DML raises 25P02. Called only
   *  from the submission point, where the submission chain guarantees
   *  every query that could still reference an evicted name has settled
   *  (a chained straggler that re-Parses a just-closed name self-heals —
   *  same path as post-DEALLOCATE re-Parse). */
  #flushPendingCloses(): void {
    const connection = this.connection;
    for (const name of this.#pendingCloses.splice(0)) {
      connection.close({ type: 'S', name });
      delete connection.parsedStatements[name];
      this.#fieldsCache.delete(name);
    }
  }

  /** Begin a trail entry for the ordinary/fast promise path, reading the SQL
   *  and values from the pre-snapshot arguments — a positional values array
   *  (pg's override) wins over a config's own `values`. Returns undefined when
   *  the trail is off, when there is no readable text, or (harmless) when
   *  neither shape applies. */
  #trailBeginOrdinary(first: unknown, positional: unknown): QueryTrailHandle | undefined {
    if (this.#trail === undefined) return undefined;
    // Text: the string form itself, or an object config's string `text`. The
    // dispatch above already routed Submittables, callbacks and null/undefined,
    // so a first arg without readable text is a malformed object we skip.
    const text = typeof first === 'string' ? first : this.#configText(first);
    /* v8 ignore next — text is undefined only via #configText's defensive no-text arm (itself ignored); every query the suite drives has readable text */
    if (text === undefined) return undefined;
    // A positional array (pg's precedence over a config's own `values`) is the
    // authoritative params; otherwise an object config's own `values`.
    const configValues = isObject(first) && Array.isArray(first.values) ? first.values : undefined;
    const values = Array.isArray(positional) ? positional : configValues;
    return this.#trail.begin(this.#trailClientId, text, values);
  }

  /** An object config's string `text`, or undefined for a non-object / no-text
   *  first argument. */
  #configText(first: unknown): string | undefined {
    /* v8 ignore next — every object config reaching #trailBeginOrdinary in the suite carries a string `text`; the no-text arm is defensive against a malformed config the fast suite does not construct */
    return isObject(first) && typeof first.text === 'string' ? first.text : undefined;
  }

  /** Begin a trail entry for a Submittable and settle it off the object's own
   *  `end`/`error` channels (passive listeners, never altering pg's dispatch).
   *  A text-bearing pg.Query records its `.text`; an opaque one without text
   *  records a `<submittable:ClassName>` tag rather than being dropped. */
  #trailBeginSubmittable(submittable: pg.Submittable): void {
    if (this.#trail === undefined) return;
    const text = (submittable as { text?: unknown }).text;
    const sql = typeof text === 'string' ? text : `<submittable:${submittable.constructor.name}>`;
    const handle = this.#trail.begin(this.#trailClientId, sql);
    const on = (submittable as { on?: unknown }).on;
    // A Submittable without an `on` is not a pg-shaped event emitter; the trail
    // entry simply stays pending (never settled) — a benign, unpinned
    // degradation of a fallback shape. isSubmittable only requires `submit`.
    // Stryker disable next-line ConditionalExpression: accept — same defensive guard; a Submittable without `on` leaves the entry pending, unobservable in the fast suite.
    /* v8 ignore next — every Submittable the suite drives (pg.Query and the opaque test double) exposes `on`; the missing-`on` guard is defensive */
    if (typeof on !== 'function') return;
    const listen = on as (event: string, listener: (...a: unknown[]) => void) => void;
    listen.call(submittable, 'end', (result: unknown) =>
      handle.settle({ rowCount: (result as { rowCount?: number | null })?.rowCount }),
    );
    /* v8 ignore next — the in-process suite drives only succeeding Submittables (they emit 'end'); an erroring Submittable's 'error' settle is a passive-observer symmetry the fast suite does not construct */
    listen.call(submittable, 'error', (error: unknown) => handle.settle({ error }));
  }

  /**
   * Build a fast-path submitter when the (already types-wrapped) arguments
   * match the exact shape `@prisma/adapter-pg` emits for a statement the
   * name generator cached: named + `rowMode: 'array'` + usable `types`.
   * Returns `undefined` for every other shape — those run the stock pg
   * Query path unchanged. The Submittable and callback forms were already
   * routed before this is consulted.
   */
  #fastSubmit(args: unknown[]): (() => Promise<FastQueryResult>) | undefined {
    if (!this.#fastQueryPath) return undefined;
    const config = args[0];
    // Stryker disable next-line ConditionalExpression: accept — non-object configs route to the stock path; every LEGAL first-arg is equivalent under `→false` (a string/number falls through the downstream `typeof name !== 'string'` check to the same `return undefined`), so only a type-illegal null/undefined first-arg distinguishes it, by throwing on `config.values` — a contract the fast suite deliberately does not pin.
    if (!isObject(config)) return undefined;

    const values = args[1] ?? config.values;
    const { name, text, types } = config;
    if (
      args.length > 2 ||
      typeof name !== 'string' ||
      name === '' ||
      typeof text !== 'string' ||
      // Stock pg owns EmptyQueryResponse semantics.
      text === '' ||
      config.rowMode !== 'array' ||
      (values !== undefined && !Array.isArray(values)) ||
      !isTypesLike(types) ||
      // Disqualifiers stock pg gives meaning to that FastQuery does not.
      // query_timeout is deliberately absent: PgBridgeClient's outer timer
      // wraps FastQuery for both explicit values and connection defaults,
      // without asking FastQuery to implement early timeout settlement or
      // clearing the execution chain before ReadyForQuery.
      config.binary ||
      config.rows ||
      config.portal ||
      config.queryMode ||
      config.callback
    ) {
      return undefined;
    }

    const fastQuery = new FastQuery({ name, text, values, types }, this.#fieldsCache);
    return () => {
      super.query(fastQuery);
      return fastQuery.promise;
    };
  }
}
