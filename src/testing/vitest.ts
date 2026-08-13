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
 * point that imports it. The runner-agnostic core lives in `./core`
 * and is shared with the `prisma-pglite-bridge/jest` entry.
 */
import { afterAll, test as baseTest, beforeEach, type TestAPI } from 'vitest';
import type { PGliteBridge } from '../pglite-bridge';
import {
  assertExactlyOneSchemaSource,
  createBridgeContext,
  createBridgeContextFromDump,
  createBridgeTemplate,
  type PGliteTestContext,
  type SetupPGliteBridgeOptions,
} from './core.ts';
import { registerTrailFailureHook, trailEnabled } from './query-trail-hook.ts';

export type { PGliteTestContext, SetupPGliteBridgeOptions } from './core.ts';

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
   * instead of once per file; `'test'` gives every test its own fresh
   * bridge — the only option safe for `test.concurrent`. To keep that
   * affordable, `'test'` builds one template per file (cold start +
   * migrations + seed, paid once) and loads a fresh, independent PGlite
   * from it per test rather than repeating the cold start — several
   * times cheaper per test (≈5x in the reference benchmark), and the
   * seed runs once per file. Each live instance still holds its own
   * in-memory data dir, so many concurrent tests trade memory for
   * isolation. Requires vitest >= 3.2.
   * Note vitest's `vmThreads`/`vmForks` pools initialize worker-scoped
   * fixtures per file, so `'worker'` amortizes only on the default
   * `threads`/`forks` pools.
   */
  scope?: 'test' | 'file' | 'worker';

  /**
   * Capture an on-failure query trail and, on a test failure, print the
   * failing test's trail to stderr. Default `true` in the helpers (the
   * failure hook only exists here). The fixture clears the trail after
   * reset/seed so shared-scope trails are per-test, registers
   * `onTestFailed`, and reads the entries synchronously on failure — before
   * any fixture teardown runs. Set `false` to disable both capture and the
   * printout. The `PGLITE_BRIDGE_QUERY_TRAIL=0` env var wins over this
   * option and can only ever disable. See
   * `.claude/plans/query-trail-design.md` §5.
   */
  queryTrail?: boolean;
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

/** The bridge fixture stores the client in a `WeakMap` before its own `use`
 *  resolves, so the entry is present when the dependent `prisma` fixture runs.
 *  The map value is `TClient | undefined`; narrow it with a guard rather than
 *  asserting — the throw is unreachable but keeps the read honest. */
const takeClient = <TClient>(
  clients: WeakMap<PGliteBridge, TClient>,
  bridge: PGliteBridge,
): TClient => {
  const client = clients.get(bridge);
  /* c8 ignore next */
  if (client === undefined) throw new Error('bridge fixture did not populate the client');
  return client;
};

/**
 * `'file'` / `'worker'` scope: one shared bridge, restored to the seeded
 * snapshot before each test that takes `prisma`.
 */
const createSharedBridgeTest = <TClient>(
  options: CreateBridgeTestOptions<TClient>,
  scope: 'file' | 'worker',
  trailOn: boolean,
): TestAPI<BridgeTestFixtures<TClient>> => {
  // The bridge fixture hands the client to the prisma fixture out of band;
  // vitest owns both lifetimes, the map just avoids a second fixture.
  const clients = new WeakMap<PGliteBridge, TClient>();

  return baseTest.extend<BridgeTestFixtures<TClient> & { _trail: undefined }>({
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
      { scope },
    ],
    // Auto per-test trail fixture: runs for EVERY test, so the clear + failure
    // hook cannot hinge on the prisma fixture. Reset traffic bypasses the pool
    // (SnapshotManager execs PGlite directly), so ordering vs the prisma
    // fixture's resetDb is irrelevant — only the setup-time seed must be
    // cleared, which this does.
    _trail: [
      async ({ bridge }: { bridge: PGliteBridge }, use: (value: undefined) => Promise<void>) => {
        installPerTestTrail(bridge, trailOn);
        await use(undefined);
      },
      { auto: true },
    ],
    prisma: async (
      { bridge }: { bridge: PGliteBridge },
      use: (value: TClient) => Promise<void>,
    ) => {
      // The bridge is shared across the scope, so restore the seeded snapshot
      // before each test that takes `prisma`. A test taking only `bridge` may
      // have mutated state, so the reset is needed even for the first test.
      await bridge.resetDb();
      // The bridge fixture always populates the map before `use` resolves.
      await use(takeClient(clients, bridge));
    },
  }) as unknown as TestAPI<BridgeTestFixtures<TClient>>;
};

/**
 * `'test'` scope: build one template per file, then load a fresh, independent
 * PGlite from it per test. A freshly loaded instance already sits at the
 * seeded state, so the prisma fixture runs no reset — and every test is fully
 * isolated, which is what makes `test.concurrent` safe here.
 */
const createTestScopedBridgeTest = <TClient>(
  options: CreateBridgeTestOptions<TClient>,
  trailOn: boolean,
): TestAPI<BridgeTestFixtures<TClient>> => {
  const clients = new WeakMap<PGliteBridge, TClient>();

  // `template` is an internal per-file fixture (the dumped template); the
  // returned type hides it so only `bridge`/`prisma` are the public surface.
  // `TestAPI` is invariant in its context type, so narrowing the wider fixtures
  // API down to the public one cannot be expressed by assignment — the
  // `as unknown as` below is the minimal honest encoding, and the public shape
  // it asserts is pinned by a type test in vitest.test.ts.
  return baseTest.extend<
    BridgeTestFixtures<TClient> & { template: Blob | File; _trail: undefined }
  >({
    template: [
      // biome-ignore lint/correctness/noEmptyPattern: vitest parses the destructure to compute fixture dependencies — `{}` declares "none".
      async ({}, use) => {
        await use(await createBridgeTemplate(options));
      },
      { scope: 'file' },
    ],
    bridge: [
      async (
        { template }: { template: Blob | File },
        use: (value: PGliteBridge) => Promise<void>,
      ) => {
        const context = await createBridgeContextFromDump(template, options);
        clients.set(context.bridge, context.prisma);
        try {
          await use(context.bridge);
        } finally {
          await context.close();
        }
      },
      { scope: 'test' },
    ],
    // Auto per-test trail fixture — see the shared-scope note. Freshly loaded
    // from the template (already seeded, no reset), so this only starts the
    // per-test trail empty and arms the printout.
    _trail: [
      async ({ bridge }: { bridge: PGliteBridge }, use: (value: undefined) => Promise<void>) => {
        installPerTestTrail(bridge, trailOn);
        await use(undefined);
      },
      { auto: true },
    ],
    prisma: async (
      { bridge }: { bridge: PGliteBridge },
      use: (value: TClient) => Promise<void>,
    ) => {
      // Freshly loaded from the template — already at seeded state, no reset.
      await use(takeClient(clients, bridge));
    },
  }) as unknown as TestAPI<BridgeTestFixtures<TClient>>;
};

/** Per-test trail wiring, shared by both bridge scopes: clear the (post-reset)
 *  trail so it starts empty for this test, then register the failure printout.
 *  A no-op when the trail is off. */
const installPerTestTrail = (bridge: PGliteBridge, trailOn: boolean): void => {
  /* v8 ignore next — the trail defaults ON, so the fast in-process helper tests never take the disabled arm; `queryTrail: false` is driven only by the hermetic child-vitest opt-out run, whose separate-process coverage the parent does not collect */
  if (!trailOn) return;
  bridge.clearQueryTrail();
  registerTrailFailureHook(bridge);
};

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
 * Setup runs once per {@link CreateBridgeTestOptions.scope}: `'file'` /
 * `'worker'` reset one shared bridge between tests, while `'test'` builds a
 * per-file template and loads a fresh instance from it for each test. Every
 * test taking `prisma` starts from the seeded state; teardown is sequenced by
 * vitest. Option validation happens synchronously at `createBridgeTest()` time.
 */
export const createBridgeTest = <TClient>(
  options: CreateBridgeTestOptions<TClient>,
): TestAPI<BridgeTestFixtures<TClient>> => {
  assertExactlyOneSchemaSource('createBridgeTest', options);
  const scope = options.scope ?? 'file';
  // Trail default ON (env > helper option). When on, force the bridge's
  // `queryTrail` on so the failure hook has entries; when off, force it off so
  // an ambient bridge option cannot leak capture past the opt-out.
  const enabled = trailEnabled(options.queryTrail);
  const effective: CreateBridgeTestOptions<TClient> = {
    ...options,
    bridge: { ...options.bridge, queryTrail: enabled },
  };
  return scope === 'test'
    ? createTestScopedBridgeTest(effective, enabled)
    : createSharedBridgeTest(effective, scope, enabled);
};
