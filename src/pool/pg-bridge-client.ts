import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteDuplex } from '../duplex';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import type { SessionLock } from '../utils/session-lock.ts';
import { isObject, isTypesLike, wrapTypesWithFastArrayParsers } from './fast-array-parsers.ts';

export interface PgBridgeClientOptions {
  pglite: PGlite | PGliteInterface;
  bridgeId: symbol;
  sessionLock?: SessionLock;
  telemetry?: TelemetrySink;
  syncToFs: boolean;
  timeout?: number;
}

type PgBridgeClientConfig = pg.ClientConfig & {
  [PgBridgeClient.OptionsKey]: PgBridgeClientOptions;
};

export class PgBridgeClient extends pg.Client {
  private querySubmissionChain?: Promise<void>;

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
  }

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

    const prior = this.querySubmissionChain;
    let p: Promise<unknown>;
    try {
      p = prior === undefined ? submit() : prior.then(submit);
    } catch (err) {
      return Promise.reject(err);
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
}
