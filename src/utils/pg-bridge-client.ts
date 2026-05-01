import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteDuplex } from '../duplex/index.ts';
import type { TelemetrySink } from './bridge-stats.ts';
import type { SessionLock } from './session-lock.ts';

interface PgBridgeClientOptions {
  pglite: PGlite;
  sessionLock?: SessionLock;
  bridgeId: symbol;
  telemetry?: TelemetrySink;
  syncToFs: boolean;
}

type PgBridgeClientConfig = pg.ClientConfig & {
  [PgBridgeClient.OptionsKey]: PgBridgeClientOptions;
};

export type PgBridgePoolConfig = pg.PoolConfig & {
  [PgBridgeClient.OptionsKey]: PgBridgeClientOptions;
};

export class PgBridgeClient extends pg.Client {
  private querySubmissionChain: Promise<void> = Promise.resolve();

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
      stream: () =>
        new PGliteDuplex(
          bridge.pglite,
          bridge.sessionLock,
          bridge.bridgeId,
          bridge.telemetry,
          bridge.syncToFs,
        ),
    });
  }

  // biome-ignore lint/suspicious/noExplicitAny: satisfy pg.Client.query's overload union
  override query(...args: unknown[]): any {
    const first = args[0];
    // biome-ignore lint/suspicious/noExplicitAny: pg.Client.query has 7 overloads
    const callSuper = () => (super.query as any).apply(this, args);

    // Preserve pg's synchronous TypeError for null/undefined query.
    if (first === null || first === undefined) return callSuper();

    // Submittable: terminal signaling isn't uniform across the pg contract.
    // Let pg's internal queue handle it unserialized. adapter-pg never uses
    // this form; users mixing Submittable + Promise forms on one client may
    // still trip the pg queue deprecation.
    if (typeof (first as { submit?: unknown }).submit === 'function') {
      return callSuper();
    }

    const prior = this.querySubmissionChain;
    let signalDone!: () => void;
    this.querySubmissionChain = new Promise<void>((resolve) => {
      signalDone = resolve;
    });

    const cbIndex = args.findIndex((arg) => typeof arg === 'function');
    if (cbIndex !== -1) {
      const origCb = args[cbIndex] as (err: unknown, res: unknown) => void;
      args[cbIndex] = (err: unknown, res: unknown) => {
        signalDone();
        origCb(err, res);
      };
      prior.then(callSuper).catch((err) => {
        signalDone();
        origCb(err, undefined);
      });
      return undefined;
    }

    const p = prior.then(callSuper);
    p.then(signalDone, signalDone);
    return p;
  }
}
