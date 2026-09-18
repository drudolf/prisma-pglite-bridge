/**
 * Runner-agnostic, Prisma-free core behind the
 * `prisma-pglite-bridge/pool/testing` entry and the `/pool/vitest` and
 * `/pool/jest` helpers — the driver-agnostic counterpart to `./core.ts`.
 * Where the Prisma core builds a `PGliteBridge` and applies a Prisma schema
 * source, this one builds a bare {@link PgBridgePool} and hands schema
 * application to the caller's `setup` callback (their ORM's migrator, or
 * raw DDL), so drizzle/kysely/knex/typeorm/mikro-orm users get the same
 * snapshot/reset testing lifecycle without any `@prisma/*` import in the
 * module graph (enforced by the CI purity gate).
 */
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { SnapshotManager } from '../pglite-bridge/snapshot-manager.ts';
import { PgBridgePool, type PgBridgePoolOptions } from '../pool';
import { assertPoolIdle } from '../utils/assert-pool-idle.ts';
import { loadTemplatePglite, rejectPglite, type TemplateCompression } from './template.ts';

/** Driver-neutral second sentence of the POOL_NOT_IDLE message —
 *  `PGliteBridge` keeps its own Prisma-flavored wording. */
const IDLE_ADVICE = 'Await all pending queries (or release checked-out clients) before calling.';

/** A dumped PGlite data directory (see {@link createPoolTemplate}). */
export type PoolTemplate = Blob | File;

export interface PoolContextOptions<TClient> {
  /**
   * Build the ORM handle from the pool, e.g.
   * `(pool) => drizzle(pool)` or
   * `(pool) => new Kysely({ dialect: new PostgresDialect({ pool }) })`.
   * Async factories (`await MikroORM.init(...)`) are awaited.
   */
  client: (pool: PgBridgePool) => TClient | Promise<TClient>;
  /**
   * Apply the schema — the ORM's migrator or raw DDL. Runs before `seed`.
   * Receives the pool and the backing PGlite instance (for tools that
   * exec SQL directly).
   */
  setup: (ctx: { pool: PgBridgePool; pglite: PGlite | PGliteInterface }) => Promise<void>;
  /** Seed data through the client; runs after `setup`, before the snapshot. */
  seed?: (client: TClient) => Promise<void>;
  /**
   * ORM-level teardown — e.g. `(db) => db.destroy()` (kysely, knex) or
   * `(orm) => orm.close()` (typeorm, mikro-orm). Called by
   * {@link PGlitePoolTestContext.close} BEFORE the pool closes; a dispose
   * that already ended the pool is tolerated (`end()` is idempotent).
   */
  dispose?: (client: TClient) => Promise<void>;
  /**
   * Snapshot the (seeded) state so `resetDb` restores it before each
   * test. Default `true`. When `false`, `resetDb` truncates to empty.
   */
  snapshot?: boolean;
  /**
   * Forwarded to the {@link PgBridgePool} constructor. A `pglite` you
   * supply stays yours: {@link PGlitePoolTestContext.close} leaves it open.
   */
  pool?: PgBridgePoolOptions;
}

export interface PoolTemplateOptions<TClient>
  extends Omit<PoolContextOptions<TClient>, 'snapshot' | 'pool'> {
  /** Forwarded to the {@link PgBridgePool} constructor. No `pglite`: a
   *  template must own the instance it dumps. */
  pool?: Omit<PgBridgePoolOptions, 'pglite'>;
  /** Dump compression. Default `'none'` — right for in-process reuse;
   *  `'gzip'` shrinks a template written to disk. Load it with the same
   *  value. */
  compression?: TemplateCompression;
}

export interface LoadPoolTemplateOptions<TClient> {
  /** See {@link PoolContextOptions.client}. */
  client: (pool: PgBridgePool) => TClient | Promise<TClient>;
  /** See {@link PoolContextOptions.dispose}. */
  dispose?: (client: TClient) => Promise<void>;
  /** Forwarded to the {@link PgBridgePool} constructor. No `pglite`: the
   *  loaded context owns the instance it loads into. */
  pool?: Omit<PgBridgePoolOptions, 'pglite'>;
  /** Must match the value the template was created with. Default
   *  `'none'`. The loader sets the matching MIME type itself, so a
   *  template read back from a file needs no type reconstruction. */
  compression?: TemplateCompression;
}

/**
 * Options of the `/pool/vitest` and `/pool/jest` `setupPGlitePool` helpers:
 * the builder options plus hook registration, which only a runner entry
 * acts on.
 */
export interface SetupPGlitePoolOptions<TClient> extends PoolContextOptions<TClient> {
  /**
   * Register `beforeEach(resetDb)` + `afterAll(close)` automatically in
   * the runner entry points. Default `true`. Set `false` to drive the
   * lifecycle yourself.
   */
  registerHooks?: boolean;
}

export interface PGlitePoolTestContext<TClient> {
  /** The client returned by the `client` factory. */
  client: TClient;
  /** The pool backing the client. */
  pool: PgBridgePool;
  /** The backing PGlite instance (template dumps, raw SQL). */
  pglite: PGlite | PGliteInterface;
  /** Restore the seeded snapshot (or truncate, without one — a context
   *  loaded from a template holds no snapshot). Requires an idle pool —
   *  throws `POOL_NOT_IDLE` while clients are checked out. */
  resetDb: () => Promise<void>;
  /** Re-capture the current state as the new `resetDb` baseline. Same
   *  idle-pool requirement as {@link resetDb}. */
  snapshotDb: () => Promise<void>;
  /** Run `dispose`, then end the pool, then close the PGlite only when
   *  this context created it (no `pool.pglite` supplied, or loaded from a
   *  template). */
  close: () => Promise<void>;
}

/** Assemble the public context over an already-built pool + client. */
const buildContext = <TClient>(
  client: TClient,
  pool: PgBridgePool,
  pglite: PGlite | PGliteInterface,
  ownsPglite: boolean,
  snapshot: SnapshotManager,
  dispose: ((client: TClient) => Promise<void>) | undefined,
): PGlitePoolTestContext<TClient> => ({
  client,
  pool,
  pglite,
  resetDb: async () => {
    assertPoolIdle(pool, 'resetDb', IDLE_ADVICE);
    return snapshot.resetDb();
  },
  snapshotDb: async () => {
    assertPoolIdle(pool, 'snapshotDb', IDLE_ADVICE);
    return snapshot.snapshotDb();
  },
  close: async () => {
    try {
      await dispose?.(client);
    } finally {
      // A dispose may already have ended the pool through the ORM's own
      // teardown (kysely's destroy() ends the dialect's pool) — pg-pool
      // throws on a second end(), so guard on its typed `ended` flag.
      if (!pool.ended) {
        await pool.end();
      }
      if (ownsPglite && !pglite.closed) {
        await pglite.close();
      }
    }
  },
});

/**
 * Hook-free heart of the pool setup helpers: create the pool (and, when
 * none is supplied, its PGlite), run `setup`, build the client, seed, and
 * (unless disabled) snapshot. On any failure after the pool is created,
 * `dispose` is attempted when the client already exists (its own error
 * swallowed) and the pool — plus an internally created PGlite — is closed
 * before the original error propagates.
 */
export const createPoolContext = async <TClient>(
  options: PoolContextOptions<TClient>,
): Promise<PGlitePoolTestContext<TClient>> => {
  const suppliedPglite = options.pool?.pglite;
  const ownsPglite = suppliedPglite === undefined;
  const pglite = suppliedPglite ?? new PGlite();
  const pool = new PgBridgePool({ ...options.pool, pglite });
  const snapshot = new SnapshotManager(pglite);

  let client: TClient | undefined;
  let clientBuilt = false;
  try {
    await options.setup({ pool, pglite });
    client = await options.client(pool);
    clientBuilt = true;
    if (options.seed) {
      await options.seed(client);
    }
    if (options.snapshot !== false) {
      await snapshot.snapshotDb();
    }
    return buildContext(client, pool, pglite, ownsPglite, snapshot, options.dispose);
  } catch (err) {
    // Best-effort teardown ordered like close(): dispose (only when the
    // client exists), pool, owned PGlite. allSettled swallows teardown
    // failures so the original setup error — the one worth debugging —
    // propagates.
    if (clientBuilt) {
      await Promise.allSettled([options.dispose?.(client as TClient)]);
    }
    await Promise.allSettled([pool.end()]);
    if (ownsPglite) {
      await Promise.allSettled([pglite.close()]);
    }
    throw err;
  }
};

/**
 * Build a pool context, apply `setup` + `seed`, then dump the resulting
 * data directory to an in-memory tarball and tear everything down. The
 * dump is a reusable, immutable template: {@link loadPoolTemplate} loads a
 * fresh, independent PGlite from it per call — in this process, or from a
 * file in another one. The pool analog of `createBridgeTemplate`.
 *
 * A dump is a raw data directory: PGlite-version-locked and schema-locked,
 * and not validated by the bridge. Key a cached template on the PGlite
 * version and the setup/seed inputs, and rebuild when any changes.
 *
 * @throws {TypeError} on a `pool.pglite` option (the template must own
 *   what it dumps).
 */
export const createPoolTemplate = async <TClient>(
  options: PoolTemplateOptions<TClient>,
): Promise<PoolTemplate> => {
  rejectPglite('createPoolTemplate', 'template', options.pool);
  // A snapshot is pointless for a template — the whole data dir is dumped.
  const context = await createPoolContext({ ...options, snapshot: false });
  try {
    return await context.pglite.dumpDataDir(options.compression ?? 'none');
  } finally {
    await context.close();
  }
};

/**
 * Load a fresh, independent PGlite from a template (see
 * {@link createPoolTemplate}), wait for it to be ready, and wrap it in a
 * pool + client. No `setup` or `seed` runs — the template already holds
 * their effects. The context owns the instance: `close()` shuts down the
 * pool AND the PGlite.
 *
 * A loaded context holds no snapshot: `resetDb()` truncates every user
 * table to empty. Load the template again for a fresh seeded state.
 *
 * @throws {PgBridgeError} `TEMPLATE_LOAD_FAILED` when PGlite cannot load
 *   the template (`cause` holds its error).
 * @throws {TypeError} on a `pool.pglite` option.
 */
export const loadPoolTemplate = async <TClient>(
  template: PoolTemplate,
  options: LoadPoolTemplateOptions<TClient>,
): Promise<PGlitePoolTestContext<TClient>> => {
  rejectPglite('loadPoolTemplate', 'loaded context', options.pool);
  const pglite = await loadTemplatePglite(template, options.compression ?? 'none');
  const pool = new PgBridgePool({ ...options.pool, pglite });
  try {
    const client = await options.client(pool);
    return buildContext(client, pool, pglite, true, new SnapshotManager(pglite), options.dispose);
  } catch (err) {
    // Same contract as createPoolContext: no PGlite outlives a failed
    // setup, and the setup error — not a teardown error — propagates.
    await Promise.allSettled([pool.end()]);
    await Promise.allSettled([pglite.close()]);
    throw err;
  }
};
