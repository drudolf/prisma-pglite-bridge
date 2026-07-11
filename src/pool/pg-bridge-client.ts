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
 *  in {@link PgBridgeClient.query} returns those to pg first. */
const isSubmittable = (value: unknown): value is pg.Submittable =>
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
   *  recycled client's next checkout, so it is rolled back here. A no-op
   *  unless the duplex reports an open transaction. */
  rollbackAbandonedTransaction(): void {
    // A client released mid-operation (an abandoned in-flight query or
    // cursor Submittable) is wedged: pg's active query will never complete,
    // so a chained ROLLBACK could never reach the wire — it would only sit
    // queued until teardown and then arm a destroy-time race against a
    // closing PGlite (the dead-WASM event-loop spin). That includes a real
    // abandoned transaction with an operation still in flight (awaited
    // BEGIN, unawaited query, release): skip silently — the destroy-time
    // rollbackIfInTransaction goes through pglite.query directly, bypassing
    // pg's queue, and remains the backstop. Abandoned-cursor releases never
    // reach the status check below anyway: the forced mid-portal
    // ReadyForQuery reports `I` (probe-verified; plan, second amendment),
    // and their dangling implicit transaction is closed by
    // releaseAbandonedPortalHold's recovery Sync.
    if (getPgActiveQuery(this) != null) return;
    if (!this.#duplexBox.current?.inTransaction) return;
    process.emitWarning(
      'A pool client was released with an open transaction; attempting ROLLBACK. ' +
        'Commit or roll back before release().',
      { type: 'PGliteBridgeAbandonedTransactionWarning' },
    );
    void (this.query('ROLLBACK') as Promise<unknown>).catch((err: unknown) => {
      // The ROLLBACK failing means the connection itself is broken — a plain
      // swallow would park a dirty client in pg-pool's idle set with the
      // session lock possibly still held. Destroy the duplex instead: its
      // _destroy path (rollbackIfInTransaction + lock cancel) is the
      // authoritative backstop, and pg-pool's idle 'error' listener removes
      // the dead client from the pool.
      /* v8 ignore next — defensive arms: pg rejects with Error instances, and the duplex outlives its client */
      this.#duplexBox.current?.destroy(err instanceof Error ? err : new Error(String(err)));
    });
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
   * Dispatch order: null/undefined and Submittable arguments go straight to
   * stock pg; the callback forms — positional or config-embedded, last
   * positional winning like pg's normalizeQueryConfig — re-enter as a
   * promise and return `undefined`; remaining object-form queries get
   * `types` wrapped with fast-array parsers, then run either the FastQuery
   * fast path or stock pg — both serialized on one submission chain so
   * mixed-path call order cannot invert.
   */
  // biome-ignore lint/suspicious/noExplicitAny: satisfy pg.Client.query's overload union
  override query(...args: unknown[]): any {
    const first = args[0];
    const submit = () => {
      // Collapse pg.Client.query's 7-overload union for a spread call; only
      // the chain path treats the result as a promise, which stock pg
      // guarantees for the shapes that reach it.
      return (super.query as unknown as (...a: unknown[]) => Promise<unknown>).apply(this, args);
    };

    // Preserve pg's synchronous TypeError for null/undefined query.
    if (first === null || first === undefined) return submit();

    // Submittable: terminal signaling isn't uniform across the pg contract.
    // Let pg's internal queue handle it unserialized. adapter-pg never uses
    // this form; users mixing Submittable + Promise forms on one client may
    // still trip the pg queue deprecation.
    if (isSubmittable(first)) {
      return submit();
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
    const submitFn = this.#fastSubmit(args) ?? submit;
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
    const m = /^\s*DEALLOCATE(?:\s+PREPARE)?\s+(?:(ALL)|"([^"]+)"|(\w+))\s*;?\s*$/i.exec(text);
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
      super.query(fastQuery as pg.Submittable);
      return fastQuery.promise;
    };
  }
}
