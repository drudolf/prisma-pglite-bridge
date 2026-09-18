/**
 * Runner-agnostic core behind the `prisma-pglite-bridge/testing` entry and
 * the `/vitest` and `/jest` helpers. Everything here is free of any
 * test-runner import, so each entry point can layer its own hooks on top
 * without pulling the other runner into its module graph.
 */
import type { PrismaPg } from '@prisma/adapter-pg';
import { PGliteBridge, type PGliteBridgeOptions } from '../pglite-bridge';
import { type PushSchemaOptions, pushSchema } from '../schema';
import { type PushMigrationsOptions, pushMigrations } from '../schema/migrations.ts';
import { loadTemplatePglite, rejectPglite, type TemplateCompression } from './template.ts';

/** A dumped PGlite data directory (see {@link createBridgeTemplate}). */
export type BridgeTemplate = Blob | File;

export interface BridgeContextOptions<TClient> {
  /**
   * Factory for the Prisma client, called with the bridge's driver
   * adapter. The bridge cannot import your generated `@prisma/client`,
   * so you construct it: `(adapter) => new PrismaClient({ adapter })`.
   */
  client: (adapter: PrismaPg) => TClient;
  /**
   * Apply `prisma/migrations` SQL. Pass `true` to auto-discover the
   * directory via `prisma.config.ts` (same resolution as
   * `prisma migrate dev`), or explicit {@link PushMigrationsOptions}.
   * Exactly one of `migrations` / `schema` must be provided.
   */
  migrations?: PushMigrationsOptions | true;
  /**
   * Apply an inline Prisma schema via the WASM schema engine instead of
   * migration files. See {@link PushSchemaOptions}.
   */
  schema?: PushSchemaOptions;
  /**
   * Runs once after the schema is applied, before the snapshot is taken.
   * Awaited — leave no queries in flight when it resolves.
   */
  seed?: (client: TClient) => Promise<void>;
  /**
   * Snapshot the (seeded) state so `resetDb` restores it before each
   * test. Default `true`. When `false`, `resetDb` truncates to empty.
   */
  snapshot?: boolean;
  /**
   * Forwarded to the {@link PGliteBridge} constructor. A `pglite` you
   * supply stays yours: {@link BridgeContext.close} leaves it open.
   */
  bridge?: PGliteBridgeOptions;
}

export interface BridgeTemplateOptions<TClient>
  extends Omit<BridgeContextOptions<TClient>, 'snapshot' | 'bridge'> {
  /** Forwarded to the {@link PGliteBridge} constructor. No `pglite`: a
   *  template must own the instance it dumps. */
  bridge?: Omit<PGliteBridgeOptions, 'pglite'>;
  /** Dump compression. Default `'none'` — right for in-process reuse;
   *  `'gzip'` shrinks a template written to disk. Load it with the same
   *  value. */
  compression?: TemplateCompression;
}

export interface LoadBridgeTemplateOptions<TClient> {
  /** See {@link BridgeContextOptions.client}. */
  client: (adapter: PrismaPg) => TClient;
  /** Forwarded to the {@link PGliteBridge} constructor. No `pglite`: the
   *  loaded context owns the instance it loads into. */
  bridge?: Omit<PGliteBridgeOptions, 'pglite'>;
  /** Must match the value the template was created with. Default
   *  `'none'`. The loader sets the matching MIME type itself, so a
   *  template read back from a file needs no type reconstruction. */
  compression?: TemplateCompression;
}

export interface BridgeContext<TClient> {
  /** The client returned by the `client` factory. */
  prisma: TClient;
  /** The underlying bridge, for manual `resetDb`/`snapshotDb`. */
  bridge: PGliteBridge;
  /**
   * End the bridge pool, and close the PGlite only when this context
   * created it (no `bridge.pglite` supplied, or loaded from a template).
   * Never calls `prisma.$disconnect()` — the pool under the client is
   * already ended; call it yourself if your runner waits on open handles.
   */
  close: () => Promise<void>;
}

/**
 * Options of the `/vitest` and `/jest` `setupPGliteBridge` helpers: the
 * builder options plus hook registration, which only a runner entry acts on.
 */
export interface SetupPGliteBridgeOptions<TClient> extends BridgeContextOptions<TClient> {
  /**
   * Register `beforeEach(resetDb)` + `afterAll(close)` automatically.
   * Default `true`. Set `false` to drive the lifecycle yourself.
   */
  registerHooks?: boolean;
}

/** What the `/vitest` and `/jest` helpers return — a {@link BridgeContext}. */
export type PGliteTestContext<TClient> = BridgeContext<TClient>;

/**
 * Guard that exactly one schema source is provided. The builders call it
 * before any {@link PGliteBridge} (and thus any PGlite) is created; the
 * runner entries call it too, so the misconfiguration surfaces
 * synchronously under the caller's own name.
 */
export const assertExactlyOneSchemaSource = (
  caller: string,
  options: { migrations?: PushMigrationsOptions | true; schema?: PushSchemaOptions },
): void => {
  if ((options.migrations === undefined) === (options.schema === undefined)) {
    throw new TypeError(
      `${caller} requires exactly one of \`migrations\` or \`schema\` to define the database shape`,
    );
  }
};

/**
 * Hook-free heart of the setup helpers: create the bridge, apply the schema
 * source, build the client, seed, and (unless disabled) snapshot. On any
 * failure after the bridge is created the bridge is closed before the error
 * propagates — no PGlite instance the context created outlives a failed
 * setup.
 *
 * @throws {TypeError} when neither or both of `migrations`/`schema` are
 *   provided (see {@link assertExactlyOneSchemaSource}).
 */
export const createBridgeContext = async <TClient>(
  options: BridgeContextOptions<TClient>,
): Promise<BridgeContext<TClient>> => {
  assertExactlyOneSchemaSource('createBridgeContext', options);
  const bridge = new PGliteBridge(options.bridge);
  let prisma: TClient;
  try {
    if (options.migrations !== undefined) {
      await pushMigrations(bridge.pglite, options.migrations === true ? {} : options.migrations);
    } else {
      const { schema } = options;
      // assertExactlyOneSchemaSource ran above, so exactly one source is set —
      // in this branch that means `schema`. The guard narrows it to
      // PushSchemaOptions without a cast; the throw is unreachable.
      /* c8 ignore next 2 */
      if (schema === undefined)
        throw new TypeError('createBridgeContext requires migrations or schema');
      await pushSchema(bridge.adapter, schema);
    }

    prisma = options.client(bridge.adapter);
    if (options.seed) {
      await options.seed(prisma);
    }
    if (options.snapshot !== false) {
      await bridge.snapshotDb();
    }
  } catch (err) {
    // Swallow a close() failure so the original setup error — the one worth
    // debugging — is what propagates, not a secondary teardown error.
    await bridge.close().catch(() => {});
    throw err;
  }

  // The bridge closes the PGlite it created and leaves a supplied one open —
  // exactly the ownership rule close() documents.
  return { prisma, bridge, close: () => bridge.close() };
};

/**
 * Build a bridge, apply the schema source, seed it, then dump the resulting
 * data directory to an in-memory tarball and tear the bridge down. The dump
 * is a reusable, immutable template: {@link loadBridgeTemplate} loads a
 * fresh, independent PGlite from it in a fraction of the time the WASM cold
 * start + migrations + seed would cost again — in this process, or from a
 * file in another one.
 *
 * A dump is a raw data directory: PGlite-version-locked and schema-locked,
 * and not validated by the bridge. Key a cached template on the PGlite
 * version and the migrations/seed inputs, and rebuild when any changes.
 *
 * @throws {TypeError} on a `bridge.pglite` option (the template must own
 *   what it dumps), or when neither or both schema sources are provided.
 */
export const createBridgeTemplate = async <TClient>(
  options: BridgeTemplateOptions<TClient>,
): Promise<BridgeTemplate> => {
  rejectPglite('createBridgeTemplate', 'template', options.bridge);
  assertExactlyOneSchemaSource('createBridgeTemplate', options);
  // A snapshot is pointless for a template — the whole data dir is dumped.
  const { bridge, close } = await createBridgeContext({ ...options, snapshot: false });
  try {
    return await bridge.pglite.dumpDataDir(options.compression ?? 'none');
  } finally {
    await close();
  }
};

/**
 * Load a fresh, independent PGlite from a template (see
 * {@link createBridgeTemplate}), wait for it to be ready, and wrap it in a
 * bridge + client. No migrations or seed run — the template already holds
 * them. The context owns the instance: {@link BridgeContext.close} shuts
 * down the pool and the PGlite.
 *
 * A loaded context holds no snapshot: `bridge.resetDb()` truncates every
 * user table to empty. Load the template again for a fresh seeded state.
 *
 * @throws {PgBridgeError} `TEMPLATE_LOAD_FAILED` when PGlite cannot load
 *   the template (`cause` holds its error).
 * @throws {TypeError} on a `bridge.pglite` option.
 */
export const loadBridgeTemplate = async <TClient>(
  template: BridgeTemplate,
  options: LoadBridgeTemplateOptions<TClient>,
): Promise<BridgeContext<TClient>> => {
  rejectPglite('loadBridgeTemplate', 'loaded context', options.bridge);
  const pglite = await loadTemplatePglite(template, options.compression ?? 'none');
  let bridge: PGliteBridge | undefined;
  try {
    const readyBridge = new PGliteBridge({ ...options.bridge, pglite });
    bridge = readyBridge;
    const prisma = options.client(readyBridge.adapter);
    return {
      prisma,
      bridge: readyBridge,
      close: async () => {
        // The bridge treats the injected pglite as caller-owned, so close it
        // here too — and in a `finally` so a bridge.close() failure can't orphan
        // the loaded WASM instance (which matters most under test.concurrent).
        try {
          await readyBridge.close();
        } finally {
          await pglite.close();
        }
      },
    };
  } catch (err) {
    // Same contract as createBridgeContext: no PGlite instance outlives a
    // failed setup, and the setup error — not a secondary teardown error —
    // is what propagates.
    await bridge?.close().catch(() => {});
    await pglite.close().catch(() => {});
    throw err;
  }
};
