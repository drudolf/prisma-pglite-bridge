/**
 * Vitest entry over the pool testing core — the driver-agnostic
 * counterpart to `prisma-pglite-bridge/vitest`. Collapses the pool +
 * schema-setup + seed + snapshot + hook boilerplate into one call:
 *
 * ```typescript
 * import { setupPGlitePool } from 'prisma-pglite-bridge/pool/vitest';
 * import { Kysely, PostgresDialect } from 'kysely';
 *
 * const { client } = await setupPGlitePool({
 *   setup: async ({ pool }) => {
 *     await pool.query('CREATE TABLE users (id serial PRIMARY KEY, name text)');
 *   },
 *   client: (pool) => new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }),
 *   seed: async (db) => {
 *     await db.insertInto('users').values({ name: 'Ada' }).execute();
 *   },
 *   dispose: (db) => db.destroy(),
 * });
 * ```
 *
 * The helper registers `beforeEach(() => context.resetDb())` and
 * `afterAll(() => context.close())`, so every test starts from the seeded
 * snapshot and the WASM instance is released when the file (or, from a
 * setup file, the worker) finishes. Hooks follow vitest's normal scoping.
 *
 * `vitest` is an optional peer dependency — this module and the Prisma
 * `/vitest` entry are the only entry points that import it. The
 * runner-agnostic core lives in `./pool-core` and is shared with the
 * `prisma-pglite-bridge/pool/jest` entry.
 */
import { afterAll, test as baseTest, beforeEach, type TestAPI } from 'vitest';
import type { PgBridgePool } from '../pool';
import {
  createPoolContext,
  createPoolContextFromDump,
  createPoolTemplate,
  type PGlitePoolTestContext,
  type SetupPGlitePoolOptions,
} from './pool-core.ts';

export type { PGlitePoolTestContext, SetupPGlitePoolOptions } from './pool-core.ts';

/**
 * Create a seeded, snapshot-backed pool test context and (by default)
 * wire it into vitest's lifecycle. See the module docs for the flow.
 *
 * On any failure after the pool is created (setup, client factory, seed,
 * snapshot), the pool — and an internally created PGlite — is closed
 * before the error propagates.
 */
export const setupPGlitePool = async <TClient>(
  options: SetupPGlitePoolOptions<TClient>,
): Promise<PGlitePoolTestContext<TClient>> => {
  const context = await createPoolContext(options);

  if (options.registerHooks !== false) {
    beforeEach(() => context.resetDb());
    afterAll(() => context.close());
  }

  return context;
};

export interface CreatePoolTestOptions<TClient>
  extends Omit<SetupPGlitePoolOptions<TClient>, 'registerHooks'> {
  /**
   * Pool-context lifetime. `'file'` (default) creates one context per
   * test file; `'worker'` shares one context across all files a worker
   * runs; `'test'` gives every test its own fresh instance — the only
   * option safe for `test.concurrent`. To keep that affordable, `'test'`
   * builds one template per file (cold start + setup + seed, paid once)
   * and loads a fresh, independent PGlite from it per test. Same scope
   * semantics as the Prisma entry's `createBridgeTest` — see its docs
   * for the trade-off dial. Requires vitest >= 3.2.
   */
  scope?: 'test' | 'file' | 'worker';
}

/** Fixtures provided by {@link createPoolTest}. */
export interface PoolTestFixtures<TClient> {
  /** The scoped pool. Taking only `pool` does NOT reset the database. */
  pool: PgBridgePool;
  /**
   * The ORM client, reset to the seeded snapshot before every test that
   * takes it. Tests touching the database should take `client`.
   */
  client: TClient;
}

/** The pool fixture stores the full context before its own `use` resolves,
 *  so the entry is present when the dependent `client` fixture runs. Narrow
 *  the read with a guard rather than asserting — the throw is unreachable
 *  but keeps the read honest. */
const takeContext = <TClient>(
  contexts: WeakMap<PgBridgePool, PGlitePoolTestContext<TClient>>,
  pool: PgBridgePool,
): PGlitePoolTestContext<TClient> => {
  const context = contexts.get(pool);
  /* c8 ignore next */
  if (context === undefined) throw new Error('pool fixture did not populate the context');
  return context;
};

/**
 * `'file'` / `'worker'` scope: one shared context, restored to the seeded
 * snapshot before each test that takes `client`.
 */
const createSharedPoolTest = <TClient>(
  options: CreatePoolTestOptions<TClient>,
  scope: 'file' | 'worker',
): TestAPI<PoolTestFixtures<TClient>> => {
  // The pool fixture hands the full context to the client fixture out of
  // band; vitest owns both lifetimes, the map just avoids a second fixture.
  const contexts = new WeakMap<PgBridgePool, PGlitePoolTestContext<TClient>>();

  return baseTest.extend<PoolTestFixtures<TClient>>({
    pool: [
      // biome-ignore lint/correctness/noEmptyPattern: vitest parses the destructure to compute fixture dependencies — `{}` declares "none".
      async ({}, use) => {
        const context = await createPoolContext(options);
        contexts.set(context.pool, context);
        try {
          await use(context.pool);
        } finally {
          await context.close();
        }
      },
      { scope },
    ],
    client: async ({ pool }: { pool: PgBridgePool }, use: (value: TClient) => Promise<void>) => {
      const context = takeContext(contexts, pool);
      // The context is shared across the scope, so restore the seeded
      // snapshot before each test that takes `client`. A test taking only
      // `pool` may have mutated state, so the reset is needed even for the
      // first test.
      await context.resetDb();
      await use(context.client);
    },
  });
};

/**
 * `'test'` scope: build one template per file, then load a fresh,
 * independent PGlite from it per test. A freshly loaded instance already
 * sits at the seeded state, so the client fixture runs no reset — and
 * every test is fully isolated, which is what makes `test.concurrent`
 * safe here.
 */
const createTestScopedPoolTest = <TClient>(
  options: CreatePoolTestOptions<TClient>,
): TestAPI<PoolTestFixtures<TClient>> => {
  const contexts = new WeakMap<PgBridgePool, PGlitePoolTestContext<TClient>>();

  // `template` is an internal per-file fixture (the dumped template); the
  // returned type hides it so only `pool`/`client` are the public surface.
  // `TestAPI` is invariant in its context type, so narrowing the wider
  // fixtures API down to the public one cannot be expressed by assignment —
  // the `as unknown as` below is the minimal honest encoding, and the
  // public shape it asserts is pinned by a type test in pool-vitest.test.ts.
  return baseTest.extend<PoolTestFixtures<TClient> & { template: Blob | File }>({
    template: [
      // biome-ignore lint/correctness/noEmptyPattern: vitest parses the destructure to compute fixture dependencies — `{}` declares "none".
      async ({}, use) => {
        await use(await createPoolTemplate(options));
      },
      { scope: 'file' },
    ],
    pool: [
      async (
        { template }: { template: Blob | File },
        use: (value: PgBridgePool) => Promise<void>,
      ) => {
        const context = await createPoolContextFromDump(template, options);
        contexts.set(context.pool, context);
        try {
          await use(context.pool);
        } finally {
          await context.close();
        }
      },
      { scope: 'test' },
    ],
    client: async ({ pool }: { pool: PgBridgePool }, use: (value: TClient) => Promise<void>) => {
      // Freshly loaded from the template — already at seeded state, no reset.
      await use(takeContext(contexts, pool).client);
    },
  }) as unknown as TestAPI<PoolTestFixtures<TClient>>;
};

/**
 * Vitest test-context (fixture) variant of {@link setupPGlitePool}:
 *
 * ```typescript
 * const test = createPoolTest({
 *   setup: async ({ pool }) => { ... },
 *   client: (pool) => drizzle(pool),
 *   seed: async (db) => { ... },
 * });
 *
 * test('starts from the seeded snapshot', async ({ client }) => { ... });
 * ```
 *
 * Setup runs once per {@link CreatePoolTestOptions.scope}: `'file'` /
 * `'worker'` reset one shared context between tests, while `'test'` builds
 * a per-file template and loads a fresh instance from it for each test.
 * Every test taking `client` starts from the seeded state; teardown
 * (dispose + pool close) is sequenced by vitest. Creating the test API
 * runs nothing — all work happens lazily at test time.
 */
export const createPoolTest = <TClient>(
  options: CreatePoolTestOptions<TClient>,
): TestAPI<PoolTestFixtures<TClient>> => {
  const scope = options.scope ?? 'file';
  return scope === 'test'
    ? createTestScopedPoolTest(options)
    : createSharedPoolTest(options, scope);
};
