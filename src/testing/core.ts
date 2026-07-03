/**
 * Runner-agnostic core shared by the `prisma-pglite-bridge/vitest` and
 * `prisma-pglite-bridge/jest` entry points. Everything here is free of any
 * test-runner import, so each entry point can layer its own hooks on top
 * without pulling the other runner into its module graph.
 */
import type { PrismaPg } from '@prisma/adapter-pg';
import { PGliteBridge, type PGliteBridgeOptions } from '../pglite-bridge';
import { type PushSchemaOptions, pushSchema } from '../schema';
import { type PushMigrationsOptions, pushMigrations } from '../schema/migrations.ts';

export interface SetupPGliteBridgeOptions<TClient> {
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
   * Register `beforeEach(resetDb)` + `afterAll(close)` automatically.
   * Default `true`. Set `false` to drive the lifecycle yourself.
   */
  registerHooks?: boolean;
  /** Forwarded to the {@link PGliteBridge} constructor. */
  bridge?: PGliteBridgeOptions;
}

export interface PGliteTestContext<TClient> {
  /** The client returned by the `client` factory. */
  prisma: TClient;
  /** The underlying bridge, for manual `resetDb`/`snapshotDb`/`close`. */
  bridge: PGliteBridge;
}

/**
 * Guard that exactly one schema source is provided. Runner entry points call
 * this before any {@link PGliteBridge} (and thus any PGlite) is created, so
 * the misconfiguration surfaces synchronously with a clear message.
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
 * propagates — no PGlite instance outlives a failed setup.
 */
export const createBridgeContext = async <TClient>(
  options: SetupPGliteBridgeOptions<TClient>,
): Promise<PGliteTestContext<TClient>> => {
  const bridge = new PGliteBridge(options.bridge);
  let prisma: TClient;
  try {
    if (options.migrations !== undefined) {
      await pushMigrations(bridge.pglite, options.migrations === true ? {} : options.migrations);
    } else {
      // The exactly-one validation before this call guarantees `schema` is set.
      await pushSchema(bridge.adapter, options.schema as PushSchemaOptions);
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

  return { prisma, bridge };
};
