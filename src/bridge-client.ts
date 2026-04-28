import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { PGliteBridge } from './pglite-bridge.ts';
import type { TelemetrySink } from './utils/adapter-stats.ts';
import type { SessionLock } from './utils/session-lock.ts';

export const bridgeClientOptionsKey: unique symbol = Symbol('bridgeClientOptions');

interface BridgeClientOptions {
  pglite: PGlite;
  sessionLock?: SessionLock;
  adapterId: symbol;
  telemetry?: TelemetrySink;
  syncToFs: boolean;
}

type BridgeClientConfig = pg.ClientConfig & {
  [bridgeClientOptionsKey]: BridgeClientOptions;
};

export type BridgePoolConfig = pg.PoolConfig & {
  [bridgeClientOptionsKey]: BridgeClientOptions;
};

export class BridgeClient extends pg.Client {
  private querySubmissionChain: Promise<void> = Promise.resolve();

  constructor(config?: BridgeClientConfig) {
    const resolved = config ?? ({} as BridgeClientConfig);
    const { [bridgeClientOptionsKey]: bridge, ...clientConfig } = resolved;
    if (!bridge) {
      throw new Error('BridgeClient requires bridge options');
    }

    super({
      ...clientConfig,
      user: 'postgres',
      database: 'postgres',
      stream: () =>
        new PGliteBridge(
          bridge.pglite,
          bridge.sessionLock,
          bridge.adapterId,
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
