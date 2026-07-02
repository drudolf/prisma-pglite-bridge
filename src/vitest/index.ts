/**
 * Vitest setup helper — collapses the bridge + schema + seed + snapshot +
 * hook boilerplate into one call.
 *
 * ```typescript
 * // test file or setupFiles entry
 * import { PrismaClient } from '@prisma/client';
 * import { setupPGliteBridge } from 'prisma-pglite-bridge/vitest';
 *
 * const { prisma } = await setupPGliteBridge({
 *   client: (adapter) => new PrismaClient({ adapter }),
 *   migrations: true, // prisma/migrations via prisma.config.ts discovery
 *   seed: async (prisma) => {
 *     await prisma.tenant.create({ data: { name: 'Acme' } });
 *   },
 * });
 * ```
 *
 * The helper registers `beforeEach(() => bridge.resetDb())` and
 * `afterAll(() => bridge.close())`, so every test starts from the seeded
 * snapshot and the WASM instance is released when the file (or, from a
 * setup file, the worker) finishes. Hooks follow vitest's normal scoping:
 * called at a file's top level they apply file-wide, called inside a
 * `describe` they apply to that block, and called from `setupFiles` they
 * apply to every file the worker runs.
 *
 * `vitest` is an optional peer dependency — this module is the only entry
 * point that imports it.
 */
import type { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeEach } from 'vitest';
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
 * Create a seeded, snapshot-backed PGlite test context and (by default)
 * wire it into vitest's lifecycle. See the module docs for the flow.
 *
 * On any failure after the bridge is created (schema apply, seed,
 * snapshot), the bridge is closed before the error propagates — no PGlite
 * instance outlives a failed setup.
 */
export const setupPGliteBridge = async <TClient>(
  options: SetupPGliteBridgeOptions<TClient>,
): Promise<PGliteTestContext<TClient>> => {
  if ((options.migrations === undefined) === (options.schema === undefined)) {
    throw new TypeError(
      'setupPGliteBridge requires exactly one of `migrations` or `schema` to define the database shape',
    );
  }

  const bridge = new PGliteBridge(options.bridge);
  let prisma: TClient;
  try {
    if (options.migrations !== undefined) {
      await pushMigrations(bridge.pglite, options.migrations === true ? {} : options.migrations);
    } else {
      // The exactly-one validation above guarantees `schema` is set here.
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
    await bridge.close();
    throw err;
  }

  if (options.registerHooks !== false) {
    beforeEach(() => bridge.resetDb());
    afterAll(() => bridge.close());
  }

  return { prisma, bridge };
};
