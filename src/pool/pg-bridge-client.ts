import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteDuplex } from '../duplex';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import type { SessionLock } from '../utils/session-lock.ts';
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
