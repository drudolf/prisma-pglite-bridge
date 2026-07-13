import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteDuplex } from '../duplex';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import type { SessionLock } from '../utils/session-lock.ts';
import { createStatementNameGenerator } from '../utils/statement-names.ts';
import { isObject, isTypesLike, wrapTypesWithFastArrayParsers } from './fast-array-parsers.ts';
import { FastQuery, type FastQueryField, type FastQueryResult } from './fast-query.ts';
import { getPgActiveQuery } from './pg-internals.ts';
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
}

type PgBridgeClientConfig = pg.ClientConfig & {
  [PgBridgeClient.OptionsKey]: PgBridgeClientOptions;
};

/** Mirrors stock pg's Submittable probe (`typeof config.submit === 'function'`,
 *  which boxes primitives). Callers pre-exclude null/undefined — the dispatch
 *  in {@link PgBridgeClient.query} returns those to pg first. The narrowed
 *  type carries the optional `handleError` pg itself uses for error delivery
 *  to Submittables, so deferred admission can route failures the same way. */
const isSubmittable = (
  value: unknown,
): value is pg.Submittable & { handleError?: (err: Error, connection: pg.Connection) => void } =>
  typeof (value as { submit?: unknown }).submit === 'function';

export class PgBridgeClient extends pg.Client {
  private querySubmissionChain?: Promise<void>;
  /** Result-field metadata per statement name, mirroring the lifetime of
   *  `connection.parsedStatements`: a recycled client starts both empty. */
  readonly #fieldsCache = new Map<string, FastQueryField[]>();
  readonly #fastQueryPath: boolean;
  /** This client's own name generator (client-unique namespace), or
   *  undefined when statement caching is off. */
  readonly #stmtNameGen?: (query: { sql: string }) => string | undefined;
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

  static readonly OptionsKey: unique symbol = Symbol('PgBridgeClientOptions');

  constructor(config?: PgBridgeClientConfig) {
    if (!config?.[PgBridgeClient.OptionsKey]) {
      throw new Error('PgBridgeClient requires bridge options');
    }
    const { [PgBridgeClient.OptionsKey]: bridge, ...clientConfig } = config;

    const duplexBox: { current?: PGliteDuplex } = {};
    super({
      ...clientConfig,
      user: 'postgres',
      database: 'postgres',
      stream: () => {
        const duplex = new PGliteDuplex(bridge.pglite, bridge);
        duplexBox.current = duplex;
        return duplex;
      },
    });

    this.#duplexBox = duplexBox;
    this.#fastQueryPath = bridge.fastQueryPath ?? true;
    this.#pglite = bridge.pglite;
    const caching = bridge.statementCaching;
    this.#stmtNameGen = caching
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
    // chained bridge-managed work behind it is wedged for good if that
    // Submittable never completes (an abandoned cursor): a chained ROLLBACK
    // could never reach the wire — it would only sit queued until teardown
    // and then arm a destroy-time race against a closing PGlite (the
    // dead-WASM event-loop spin). Skip silently — the destroy-time
    // rollbackIfInTransaction goes through pglite.query directly, bypassing
    // pg's queue, and remains the backstop. Abandoned-cursor releases never
    // reach the transaction check below anyway: the forced mid-portal
    // ReadyForQuery reports `I` (probe-verified; plan, second amendment),
    // and their dangling implicit transaction is closed by
    // releaseAbandonedPortalHold's recovery Sync.
    if (getPgActiveQuery(this) != null && this.querySubmissionChain === undefined) return;
    // Known residual (probe-pinned by the composite-window test): chained
    // work queued BEHIND a wedged Submittable inside an explicit transaction
    // registers a link that never runs before teardown — the tail can only
    // settle after a terminating Sync the abandoned cursor will never send,
    // and releaseAbandonedPortalHold deliberately keeps ownership on T/E.
    // The link stays dormant (its run-time re-check finds the duplex
    // destroyed at teardown drain), so the cost is the documented
    // unbounded sibling wait, bounded by the pool's lifetime. Lifting it
    // means manufacturing the recovery Sync inside an explicit transaction
    // too — a duplex-level change deferred to its own design round.
    //
    // Idle client outside a transaction: nothing abandoned. A client WITH
    // chained work is deliberately not screened on inTransaction here — the
    // verdict belongs to AFTER that work settles (an unawaited BEGIN opens
    // a transaction, an unawaited COMMIT closes one), so the cleanup link
    // re-checks when it runs.
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
      /* v8 ignore next — a release-registered link implies the stream factory ran */
      if (duplex === undefined) return Promise.resolve();
      // Teardown won the race (or the in-flight query died with its
      // connection): the duplex _destroy path already rolls back. And a
      // transaction closed by the in-flight work itself needs no cleanup.
      if (duplex.destroyed || !duplex.inTransaction) return Promise.resolve();
      process.emitWarning(
        'A pool client was released with an open transaction; attempting ROLLBACK. ' +
          'Commit or roll back before release().',
        { type: 'PGliteBridgeAbandonedTransactionWarning' },
      );
      // super.query, not this.query: re-entering query() from a chain link
      // would chain onto the link's own unsettled tail and deadlock. A bare
      // ROLLBACK needs none of query()'s added services (no statement
      // naming, no dealloc intercept, no fast path).
      return super.query('ROLLBACK').then(
        () => undefined,
        (err: unknown) => {
          // The ROLLBACK failing means the connection itself is broken — a
          // plain swallow would park a dirty client in pg-pool's idle set
          // with the session lock possibly still held. Destroy the duplex
          // instead: its _destroy path (rollbackIfInTransaction + lock
          // cancel) is the authoritative backstop, and pg-pool's idle
          // 'error' listener removes the dead client from the pool.
          /* v8 ignore next — defensive arm: pg rejects with Error instances, and the duplex outlives its client */
          this.#duplexBox.current?.destroy(err instanceof Error ? err : new Error(String(err)));
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
  get teardown(): { settled: Promise<void>; abort: (reason: Error) => void } {
    const duplex = this.#duplexBox.current;
    return {
      /* v8 ignore next — the pool reads this on 'connect', where the factory has always run */
      settled: duplex?.onClose ?? Promise.resolve(),
      /* v8 ignore next — invoked only from end()'s defensive drain-bound expiry */
      abort: (reason) => duplex?.destroy(reason),
    };
  }

  /**
   * Dispatch order: null/undefined go straight to stock pg; Submittables
   * return synchronously with their ADMISSION deferred behind the
   * submission chain (call order preserved, completion untracked); the
   * callback forms — positional or config-embedded, last positional winning
   * like pg's normalizeQueryConfig — re-enter as a promise and return
   * `undefined`; remaining object-form queries get `types` wrapped with
   * fast-array parsers, then run either the FastQuery fast path or stock
   * pg — both serialized on one submission chain so mixed-path call order
   * cannot invert.
   */
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
      const prior = this.querySubmissionChain;
      if (prior === undefined) {
        super.query(first);
      } else {
        // `prior` is a chain tail and never rejects (both settle arms release it).
        void prior.then(() => {
          try {
            super.query(first);
          } catch (err) {
            // pg delivers ended/errored-client failures through the
            // Submittable's own handleError (never a throw to the caller);
            // route a synchronous admission throw — e.g. a user submit()
            // that throws once pulsed — the same way instead of leaking it
            // as an unhandled rejection from this chain hop.
            first.handleError?.(
              err instanceof Error ? err : new Error(String(err)),
              this.connection,
            );
          }
        });
      }
      return first;
    }

    // pg's query(config, values, callback) collapses positional functions and
    // a config-embedded `callback` into one slot (last positional wins).
    // Handle every callback form, then return `undefined` like stock pg does
    // in callback mode.
    if (this.#dispatchCallbackForm(args, first)) return undefined;

    if (isObject(first) && isTypesLike(first.types)) {
      args[0] = {
        ...first,
        types: wrapTypesWithFastArrayParsers(first.types),
      };
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
    // stock pg runs it.
    if (this.#stmtNameGen && isObject(args[0])) {
      const queryConfig = args[0] as Record<string, unknown>;
      if (typeof queryConfig.text === 'string' && queryConfig.name == null) {
        const name = this.#stmtNameGen({ sql: queryConfig.text });
        if (name !== undefined) args[0] = { ...queryConfig, name };
      }
    }

    // Detect DEALLOCATE before submitting so we can sync pg's plan cache
    // with PGlite after the statement resolves.
    const dealloc = this.#detectDeallocate(args);

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
    let rawQueryPromise: Promise<unknown>;
    if (prior === undefined) {
      try {
        rawQueryPromise = submitWithCloses();
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      rawQueryPromise = prior.then(submitWithCloses);
    }

    // After PGlite confirms a DEALLOCATE / DISCARD ALL, evict matching entries
    // from pg's parsedStatements (the skip-Parse guard) and #fieldsCache on
    // EVERY live client of this PGlite instance — the session-wide wipe
    // invalidates names any of them may hold, not just the issuer's. Without
    // this, a sibling would skip Parse for a name PGlite forgot and fail its
    // next Bind with Postgres error 26000.
    const queryPromise =
      dealloc === null
        ? rawQueryPromise
        : rawQueryPromise.then((result: unknown) => {
            const clients = liveClients.get(this.#pglite);
            /* v8 ignore next — the issuer stays registered until 'end'; a dealloc resolving after teardown is unreachable through the pool */
            if (clients !== undefined) {
              for (const client of clients) client.#clearStatementCaches(dealloc);
            }
            return result;
          });

    // Register this query's tail on the submission chain; each query clears
    // only its own slot (identity check) so concurrent queries never stomp.
    let chainTail: Promise<void>;
    const releaseChainTail = () => {
      if (this.querySubmissionChain === chainTail) {
        this.querySubmissionChain = undefined;
      }
    };
    chainTail = queryPromise.then(releaseChainTail, releaseChainTail);
    this.querySubmissionChain = chainTail;
    return queryPromise;
  }

  /** Handle the callback forms of `query()`: positional functions after the
   *  first argument and a config-embedded `callback`, last positional winning
   *  like pg's normalizeQueryConfig. Re-enters as a promise and invokes the
   *  callback; returns `true` when it fired (the caller returns `undefined`
   *  like stock pg in callback mode), `false` when there is no callback. */
  #dispatchCallbackForm(args: unknown[], first: unknown): boolean {
    const promiseArgs: unknown[] = [first];
    let origCb: ((err: unknown, res: unknown) => void) | undefined;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg === 'function') {
        origCb = arg as (err: unknown, res: unknown) => void;
      } else {
        promiseArgs.push(arg);
      }
    }
    if (origCb === undefined && isObject(first) && typeof first.callback === 'function') {
      origCb = first.callback as (err: unknown, res: unknown) => void;
    }
    if (origCb === undefined) return false;

    const cb = origCb;
    if (isObject(first) && 'callback' in first) {
      // Strip even a non-function `callback` — pg would overwrite it with the
      // positional one, so it must not resurface on re-entry.
      const { callback: _callback, ...rest } = first;
      promiseArgs[0] = rest;
    }

    try {
      // Known deviation: a callback that throws surfaces as an unhandled
      // rejection here, where stock pg propagates it synchronously from the
      // connection's message handler (uncaughtException channel). adapter-pg
      // never uses callback mode.
      this.query(...promiseArgs).then(
        (res: unknown) => cb(null, res),
        (err: unknown) => cb(err, undefined),
      );
    } catch (err) {
      cb(err, undefined);
    }
    return true;
  }

  /** Returns the eviction scope if args describe a DEALLOCATE or DISCARD ALL
   *  statement, `null` otherwise. Handles both string form
   *  (`query('DEALLOCATE ALL')`) and object form
   *  (`query({ text: 'DEALLOCATE ALL' })`). */
  #detectDeallocate(args: unknown[]): { all: true } | { name: string } | null {
    const first = args[0];
    const text =
      typeof first === 'string'
        ? first
        : isObject(first) && typeof (first as Record<string, unknown>).text === 'string'
          ? ((first as Record<string, unknown>).text as string)
          : null;
    if (!text) return null;
    // DISCARD ALL includes DEALLOCATE ALL semantics — the same session-wide
    // statement wipe. (DISCARD PLANS/SEQUENCES/TEMP leave statements intact.)
    if (/^\s*DISCARD\s+ALL\s*;?\s*$/i.test(text)) return { all: true };
    // Quoted identifiers keep their exact spelling; unquoted ones are folded
    // to lowercase, matching how PostgreSQL resolves the DEALLOCATE target —
    // without the fold, `DEALLOCATE FOO` would deallocate `foo` server-side
    // while the eviction missed pg's cache entry for it (26000 on next use).
    // Unquoted identifiers admit `$` past the first character; [\w$]+ is a
    // lenient superset, which is safe — the caller only evicts after the
    // server CONFIRMED the DEALLOCATE, so a match on SQL the server rejects
    // can never evict a live name. Known misses, each bounded to a skipped
    // eviction (26000 on next use — the status quo for undetected shapes,
    // never a false eviction): quoted identifiers with escaped inner quotes
    // (`"a""b"`) and non-ASCII unquoted identifiers (\w is ASCII-only).
    const m = /^\s*DEALLOCATE(?:\s+PREPARE)?\s+(?:(ALL)|"([^"]+)"|([\w$]+))\s*;?\s*$/i.exec(text);
    if (!m) return null;
    if (m[1] !== undefined) return { all: true };
    if (m[2] !== undefined) return { name: m[2] };
    return { name: (m[3] as string).toLowerCase() };
  }

  /** Evict statement entries from pg's internal parsedStatements map and from
   *  #fieldsCache after a confirmed DEALLOCATE / DISCARD ALL. pg uses
   *  parsedStatements to skip the Parse message on repeat named-statement
   *  calls; if PGlite's copy is gone but pg's is not, the next Bind fails with
   *  Postgres error 26000. #fieldsCache mirrors parsedStatements' lifetime per
   *  its own comment. Scope: this client only — session-wide propagation is
   *  the caller's job (the dealloc intercept in query() iterates the
   *  liveClients registry). */
  #clearStatementCaches(scope: { all: true } | { name: string }): void {
    const ps = this.connection.parsedStatements;
    if ('all' in scope) {
      for (const key of Object.keys(ps)) delete ps[key];
      this.#fieldsCache.clear();
    } else {
      delete ps[scope.name];
      this.#fieldsCache.delete(scope.name);
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
      [config.binary, config.rows, config.portal, config.queryMode, config.callback].some(Boolean)
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
