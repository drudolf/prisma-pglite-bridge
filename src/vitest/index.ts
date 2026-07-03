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
 * point that imports it. The runner-agnostic core lives in `../testing/core`
 * and is shared with the `prisma-pglite-bridge/jest` entry.
 */
import { afterAll, test as baseTest, beforeEach, type TestAPI } from 'vitest';
import type { PGliteBridge } from '../pglite-bridge';
import {
  assertExactlyOneSchemaSource,
  createBridgeContext,
  type PGliteTestContext,
  type SetupPGliteBridgeOptions,
} from '../testing/core.ts';

export type { PGliteTestContext, SetupPGliteBridgeOptions } from '../testing/core.ts';

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
  assertExactlyOneSchemaSource('setupPGliteBridge', options);

  const context = await createBridgeContext(options);

  if (options.registerHooks !== false) {
    beforeEach(() => context.bridge.resetDb());
    afterAll(() => context.bridge.close());
  }

  return context;
};

export interface CreateBridgeTestOptions<TClient>
  extends Omit<SetupPGliteBridgeOptions<TClient>, 'registerHooks'> {
  /**
   * Bridge lifetime. `'file'` (default) creates one bridge per test
   * file; `'worker'` shares one bridge across all files a worker runs —
   * the WASM cold start, migrations, and seed are paid once per worker
   * instead of once per file; `'test'` creates a fresh bridge per test —
   * the costliest option (full cold start per test) and the only one
   * safe for `test.concurrent`. Requires vitest >= 3.2. Note vitest's
   * `vmThreads`/`vmForks` pools initialize worker-scoped fixtures per
   * file, so `'worker'` amortizes only on the default `threads`/`forks`
   * pools.
   */
  scope?: 'test' | 'file' | 'worker';
}

/** Fixtures provided by {@link createBridgeTest}. */
export interface BridgeTestFixtures<TClient> {
  /** The scoped bridge. Taking only `bridge` does NOT reset the database. */
  bridge: PGliteBridge;
  /**
   * The Prisma client, reset to the seeded snapshot before every test
   * that takes it. Tests touching the database should take `prisma`.
   */
  prisma: TClient;
}

/**
 * Vitest test-context (fixture) variant of {@link setupPGliteBridge}:
 *
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 * import { createBridgeTest } from 'prisma-pglite-bridge/vitest';
 *
 * const test = createBridgeTest({
 *   client: (adapter) => new PrismaClient({ adapter }),
 *   migrations: true,
 *   seed: async (prisma) => {
 *     await prisma.tenant.create({ data: { name: 'Acme' } });
 *   },
 * });
 *
 * test('starts from the seeded snapshot', async ({ prisma }) => {
 *   expect(await prisma.tenant.count()).toBe(1);
 * });
 * ```
 *
 * Setup (bridge, schema, seed, snapshot) runs once per {@link
 * CreateBridgeTestOptions.scope}; the bridge is closed by vitest when the
 * scope ends. Every test taking `prisma` starts from the seeded snapshot.
 * Option validation happens synchronously at `createBridgeTest()` time.
 */
export const createBridgeTest = <TClient>(
  options: CreateBridgeTestOptions<TClient>,
): TestAPI<BridgeTestFixtures<TClient>> => {
  assertExactlyOneSchemaSource('createBridgeTest', options);

  // The bridge fixture hands the client to the prisma fixture out of band;
  // vitest owns both lifetimes, the map just avoids a second fixture.
  const clients = new WeakMap<PGliteBridge, TClient>();

  return baseTest.extend<BridgeTestFixtures<TClient>>({
    bridge: [
      // biome-ignore lint/correctness/noEmptyPattern: vitest parses the destructure to compute fixture dependencies — `{}` declares "none".
      async ({}, use) => {
        const context = await createBridgeContext(options);
        clients.set(context.bridge, context.prisma);
        try {
          await use(context.bridge);
        } finally {
          await context.bridge.close();
        }
      },
      { scope: options.scope ?? 'file' },
    ],
    prisma: async (
      { bridge }: { bridge: PGliteBridge },
      use: (value: TClient) => Promise<void>,
    ) => {
      // A test-scoped bridge is freshly created and already sits at the
      // seeded snapshot state — resetting it would only burn a
      // truncate-and-restore cycle. File/worker scopes must reset even for
      // their first test: an earlier test taking only `bridge` may have
      // mutated state, so freshness is only provable at `'test'` scope.
      if ((options.scope ?? 'file') !== 'test') {
        await bridge.resetDb();
      }
      // The bridge fixture always populates the map before `use` resolves.
      await use(clients.get(bridge) as TClient);
    },
  });
};
