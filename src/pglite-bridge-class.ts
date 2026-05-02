/**
 * Prototype: class-based PGliteBridge with a synchronous constructor.
 *
 * Strict-invariant variant of the {@link createPGliteBridge} factory:
 * requires the caller-supplied PGlite instance to already be ready
 * (`pglite.ready === true`) and not closed. The factory currently does
 * `await pglite.waitReady` internally; this prototype shifts that
 * responsibility onto the caller, enabling a plain `new PGliteBridge(opts)`
 * with no static factory dance.
 *
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { PGliteBridge } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const pglite = new PGlite();
 * await pglite.waitReady;          // strict-invariant — required
 * const bridge = new PGliteBridge({ pglite });
 * const prisma = new PrismaClient({ adapter: bridge.adapter });
 * ```
 *
 * Public methods are arrow-function class fields so destructuring stays safe:
 * `const { resetDb } = bridge; await resetDb();` works as expected.
 */
import type { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import type { PGliteBridgeOptions } from './pglite-bridge.ts';
import type { SyncToFsMode } from './pool.ts';
import { BridgeStats, type Stats } from './utils/bridge-stats.ts';
import { PgBridgeClient, type PgBridgePoolConfig } from './utils/pg-bridge-client.ts';
import { SessionLock } from './utils/session-lock.ts';
import { createSnapshotManager, type SnapshotManager } from './utils/snapshot.ts';

const resolveSyncToFs = (pglite: PGlite, mode: SyncToFsMode | undefined): boolean => {
  if (mode === true || mode === false) return mode;
  const dataDir = pglite.dataDir;
  return !(dataDir === undefined || dataDir === '' || dataDir.startsWith('memory://'));
};

/** @internal Exported for testing. */
export const emitBridgeLeakWarning = (): void => {
  process.emitWarning(
    'PGliteBridge was garbage-collected before close() was called. ' +
      'Call bridge.close() to release the pool and finalize stats().',
    { type: 'PGliteBridgeLeakWarning' },
  );
};

const leakRegistry = new FinalizationRegistry<void>(emitBridgeLeakWarning);

export class PGliteBridge {
  readonly adapter: PrismaPg;
  readonly pglite: PGlite;
  readonly bridgeId: symbol;

  readonly #pool: pg.Pool;
  readonly #stats: BridgeStats | undefined;
  readonly #snapshot: SnapshotManager;
  readonly #leakToken: object = {};
  #closing: Promise<void> | undefined;

  constructor(options: PGliteBridgeOptions) {
    const { pglite } = options;

    if (!pglite.ready) {
      throw new Error(
        'PGliteBridge requires a ready PGlite instance. ' +
          'Call `await pglite.waitReady` after `new PGlite(...)` before constructing the bridge.',
      );
    }
    if (pglite.closed) {
      throw new Error('PGliteBridge requires an open PGlite instance; got a closed one.');
    }

    const statsLevel = options.statsLevel ?? 'off';
    if (statsLevel !== 'off' && statsLevel !== 'basic' && statsLevel !== 'full') {
      throw new Error(`statsLevel must be 'off', 'basic', or 'full'; got ${String(statsLevel)}`);
    }

    const max = options.max ?? 1;
    const bridgeId = Symbol('bridge');
    const stats = statsLevel === 'off' ? undefined : new BridgeStats(statsLevel);
    const sessionLock = max > 1 ? new SessionLock() : undefined;
    const syncToFs = resolveSyncToFs(pglite, options.syncToFs);

    const poolConfig: PgBridgePoolConfig = {
      Client: PgBridgeClient,
      max,
      [PgBridgeClient.OptionsKey]: {
        pglite,
        sessionLock,
        bridgeId,
        telemetry: stats,
        syncToFs,
      },
    };
    const pool = new pg.Pool(poolConfig);

    this.pglite = pglite;
    this.bridgeId = bridgeId;
    this.adapter = new PrismaPg(pool);
    this.#pool = pool;
    this.#stats = stats;
    this.#snapshot = createSnapshotManager(pglite);

    leakRegistry.register(this.adapter, undefined, this.#leakToken);
  }

  resetDb = async (): Promise<void> => {
    this.#stats?.incrementResetDb();
    await this.#snapshot.resetDb();
  };

  snapshotDb = async (): Promise<void> => {
    await this.#snapshot.snapshotDb();
  };

  resetSnapshot = async (): Promise<void> => {
    await this.#snapshot.resetSnapshot();
  };

  close = async (): Promise<void> => {
    if (!this.#closing) {
      this.#closing = (async () => {
        const closeEntry = this.#stats ? process.hrtime.bigint() : undefined;
        await this.#pool.end();
        if (this.#stats && closeEntry !== undefined) {
          await this.#stats.freeze(this.pglite, closeEntry);
        }
        leakRegistry.unregister(this.#leakToken);
      })();
    }
    return this.#closing;
  };

  stats = async (): Promise<Stats | undefined> => {
    return this.#stats ? this.#stats.snapshot(this.pglite) : undefined;
  };
}
