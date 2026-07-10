import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteDuplex } from '../duplex';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import type { SessionLock } from '../utils/session-lock.ts';
import { isObject, isTypesLike, wrapTypesWithFastArrayParsers } from './fast-array-parsers.ts';
import {
  FastQuery,
  type FastQueryField,
  type FastQueryResult,
  type FastQueryTypes,
} from './fast-query.ts';

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

export class PgBridgeClient extends pg.Client {
  private querySubmissionChain?: Promise<void>;
  /** Result-field metadata per statement name, mirroring the lifetime of
   *  `connection.parsedStatements`: a recycled client starts both empty. */
  readonly #fieldsCache = new Map<string, FastQueryField[]>();
  readonly #fastQueryPath: boolean;

  static readonly OptionsKey: unique symbol = Symbol('PgBridgeClientOptions');

  constructor(config?: PgBridgeClientConfig) {
    const resolved = config ?? ({} as PgBridgeClientConfig);
    const { [PgBridgeClient.OptionsKey]: bridge, ...clientConfig } = resolved;
    if (!bridge) {
      throw new Error('PgBridgeClient requires bridge options');
    }

    super({
      ...clientConfig,
      user: 'postgres',
      database: 'postgres',
      stream: () => new PGliteDuplex(bridge.pglite, bridge),
    });

    this.#fastQueryPath = bridge.fastQueryPath ?? true;
  }

  /**
   * Dispatch order: null/undefined and Submittable arguments go straight to
   * stock pg; the callback form re-enters as a promise; remaining
   * object-form queries get `types` wrapped with fast-array parsers, then
   * run either the FastQuery fast path or stock pg — both serialized on one
   * submission chain so mixed-path call order cannot invert.
   */
  // biome-ignore lint/suspicious/noExplicitAny: satisfy pg.Client.query's overload union
  override query(...args: unknown[]): any {
    const first = args[0];
    const submit = () => {
      // biome-ignore lint/suspicious/noExplicitAny: pg.Client.query has 7 overloads
      return (super.query as any).apply(this, args) as Promise<unknown>;
    };

    // Preserve pg's synchronous TypeError for null/undefined query.
    if (first === null || first === undefined) return submit();

    // Submittable: terminal signaling isn't uniform across the pg contract.
    // Let pg's internal queue handle it unserialized. adapter-pg never uses
    // this form; users mixing Submittable + Promise forms on one client may
    // still trip the pg queue deprecation.
    if (typeof (first as { submit?: unknown }).submit === 'function') {
      return submit();
    }

    const cbIndex = args.findIndex((arg) => typeof arg === 'function');
    if (cbIndex !== -1) {
      const origCb = args[cbIndex] as (err: unknown, res: unknown) => void;
      const promiseArgs = args.slice();
      promiseArgs.splice(cbIndex, 1);

      try {
        this.query(...promiseArgs).then(
          (res: unknown) => origCb(null, res),
          (err: unknown) => origCb(err, undefined),
        );
      } catch (err) {
        origCb(err, undefined);
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
    const eligible =
      args.length <= 2 &&
      typeof name === 'string' &&
      name !== '' &&
      typeof text === 'string' &&
      config.rowMode === 'array' &&
      (values === undefined || Array.isArray(values)) &&
      isTypesLike(types) &&
      // Disqualifiers stock pg gives meaning to that FastQuery does not.
      ![config.binary, config.rows, config.portal, config.queryMode, config.callback].some(Boolean);
    if (!eligible) return undefined;

    const fastQuery = new FastQuery(
      {
        name: name as string,
        text: text as string,
        values: values as unknown[] | undefined,
        types: types as FastQueryTypes,
      },
      this.#fieldsCache,
    );
    return () => {
      super.query(fastQuery as unknown as pg.Submittable);
      return fastQuery.promise;
    };
  }
}
