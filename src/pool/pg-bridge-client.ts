import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteDuplex } from '../duplex';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import type { SessionLock } from '../utils/session-lock.ts';
import { createStatementNameGenerator } from '../utils/statement-names.ts';
import { isObject, isTypesLike, wrapTypesWithFastArrayParsers } from './fast-array-parsers.ts';
import { FastQuery, type FastQueryField, type FastQueryResult } from './fast-query.ts';

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
   * `connection.parsedStatements`. The client creates its own bounded
   * generator — names are `ppb_<namespace>_<n>` with a process-unique
   * namespace per client, so names from different clients (or client
   * generations) never collide in the shared PGlite session. See
   * PgBridgePoolOptions.statementCaching.
   */
  statementCaching?: boolean;
}

type PgBridgeClientConfig = pg.ClientConfig & {
  [PgBridgeClient.OptionsKey]: PgBridgeClientOptions;
};

/** Mirrors stock pg's Submittable probe (`typeof config.submit === 'function'`,
 *  which boxes primitives). Callers pre-exclude null/undefined — the dispatch
 *  in {@link PgBridgeClient.query} returns those to pg first. */
const isSubmittable = (value: unknown): value is pg.Submittable =>
  typeof (value as { submit?: unknown }).submit === 'function';

// Live clients per PGlite instance. PGlite is one shared session: a
// DEALLOCATE / DISCARD ALL issued through ANY client wipes server-side
// statements that every client's pg parse-skip cache may still reference.
// The registry lets the dealloc intercept in query() evict from all live
// clients, not just the issuer. Clients register at construction and
// deregister on their own 'end' event plus a belt-and-suspenders hook in
// PgBridgePool's 'remove' listener; a stale entry is harmless — evicting a
// dead client's caches is a no-op.
const liveClients = new WeakMap<object, Set<PgBridgeClient>>();

export class PgBridgeClient extends pg.Client {
  private querySubmissionChain?: Promise<void>;
  /** Result-field metadata per statement name, mirroring the lifetime of
   *  `connection.parsedStatements`: a recycled client starts both empty. */
  readonly #fieldsCache = new Map<string, FastQueryField[]>();
  readonly #fastQueryPath: boolean;
  /** This client's own name generator (client-unique namespace), or
   *  undefined when statement caching is off. */
  readonly #stmtNameGen?: (query: { sql: string }) => string | undefined;
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
    this.#stmtNameGen = bridge.statementCaching ? createStatementNameGenerator() : undefined;

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

    // pg's normalizeQueryConfig collapses every positional function and a
    // config-embedded `callback` into one callback slot — the last positional
    // function wins over `config.callback`. Mirror that, re-enter as a
    // promise, and return `undefined` like stock pg does in callback mode.
    const promiseArgs: unknown[] = [];
    let origCb: ((err: unknown, res: unknown) => void) | undefined;
    for (const arg of args) {
      if (typeof arg === 'function') {
        origCb = arg as (err: unknown, res: unknown) => void;
      } else {
        promiseArgs.push(arg);
      }
    }
    if (origCb === undefined && isObject(first) && typeof first.callback === 'function') {
      origCb = first.callback as (err: unknown, res: unknown) => void;
    }
    if (origCb !== undefined) {
      const cb = origCb;
      if (isObject(first) && 'callback' in first) {
        // Strip even a non-function `callback` — pg would overwrite it with
        // the positional one, so it must not resurface on re-entry.
        const { callback: _callback, ...rest } = first;
        promiseArgs[0] = rest;
      }

      try {
        this.query(...promiseArgs).then(
          (res: unknown) => cb(null, res),
          (err: unknown) => cb(err, undefined),
        );
      } catch (err) {
        cb(err, undefined);
      }
      return undefined;
    }

    if (isObject(first) && isTypesLike(first.types)) {
      args[0] = {
        ...first,
        types: wrapTypesWithFastArrayParsers(first.types),
      };
    }

    // Inject a stable name into unnamed cacheable DML so PGlite caches the
    // query plan via EQP. pg skips Parse on repeat calls for named statements
    // (connection.parsedStatements guard in Query.prepare). Submittable queries
    // are already dispatched above; string-form queries are excluded by the
    // isObject guard below.
    if (this.#stmtNameGen && isObject(args[0])) {
      const c = args[0] as Record<string, unknown>;
      if (typeof c.text === 'string' && c.name == null) {
        const name = this.#stmtNameGen({ sql: c.text });
        if (name !== undefined) args[0] = { ...c, name };
      }
    }

    // Detect DEALLOCATE before submitting so we can sync pg's plan cache
    // with PGlite after the statement resolves.
    const dealloc = this.#detectDeallocate(args);

    // The fast path rides the SAME submission chain as stock object-form
    // queries — a FastQuery must never jump ahead of a chained pending
    // stock query, or mixed-path call order would invert.
    const doSubmit = this.#fastSubmit(args) ?? submit;

    const prior = this.querySubmissionChain;
    let p: Promise<unknown>;
    if (prior === undefined) {
      try {
        p = doSubmit();
      } catch (err) {
        return Promise.reject(err);
      }
    } else {
      p = prior.then(doSubmit);
    }

    if (dealloc !== null) {
      // After PGlite confirms the DEALLOCATE / DISCARD ALL, evict matching
      // entries from pg's parsedStatements (the skip-Parse guard) and
      // #fieldsCache on EVERY live client of this PGlite instance — the
      // session-wide wipe invalidates names any of them may hold, not just
      // the issuer's. Without this, a sibling would skip Parse for a name
      // PGlite forgot and fail its next Bind with Postgres error 26000.
      p = p.then((result: unknown) => {
        const clients = liveClients.get(this.#pglite);
        /* v8 ignore next — the issuer stays registered until 'end'; a dealloc resolving after teardown is unreachable through the pool */
        if (clients !== undefined) {
          for (const client of clients) client.#clearStatementCaches(dealloc);
        }
        return result;
      });
    }

    let done: Promise<void>;
    const clearChain = () => {
      if (this.querySubmissionChain === done) {
        this.querySubmissionChain = undefined;
      }
    };
    done = p.then(clearChain, clearChain);
    this.querySubmissionChain = done;
    return p;
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
    const ps = (this as unknown as { connection?: { parsedStatements?: Record<string, string> } })
      .connection?.parsedStatements;
    if ('all' in scope) {
      /* v8 ignore next — ps exists on every pg Connection; guard covers pg internals drift */
      if (ps) {
        for (const key of Object.keys(ps)) delete ps[key];
      }
      this.#fieldsCache.clear();
    } else {
      /* v8 ignore next — ps exists on every pg Connection; guard covers pg internals drift */
      if (ps) delete ps[scope.name];
      this.#fieldsCache.delete(scope.name);
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
      super.query(fastQuery as unknown as pg.Submittable);
      return fastQuery.promise;
    };
  }
}
