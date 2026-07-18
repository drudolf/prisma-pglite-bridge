/**
 * Red-first tests for `./pool-vitest.ts` — the vitest entry over the pool
 * core, mirroring `./vitest.ts`. The module does not exist yet. Hook
 * behavior is pinned functionally: the contexts below are created at the
 * file's top level, so the hooks `setupPGlitePool` registers apply
 * file-wide, exactly as the sibling bridge entry documents for vitest's
 * normal hook scoping.
 */
import type { TestAPI } from 'vitest';
import { afterAll, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { PgBridgePool } from '../pool/index.ts';
import { createPoolTest, type PoolTestFixtures, setupPGlitePool } from './pool-vitest.ts';

/** Read a table's `label` column in id order — the assertion currency below. */
const labels = async (pool: PgBridgePool, table: string): Promise<string[]> => {
  const { rows } = await pool.query<{ label: string }>(`SELECT label FROM ${table} ORDER BY id`);
  return rows.map((row) => row.label);
};

// Default hooks: beforeEach(resetDb) + afterAll(close) registered file-wide.
// Each top-level context lets the core create (and own) its PGlite so the
// registered afterAll is also what tears the instance down.
const hooked = await setupPGlitePool({
  setup: async ({ pool }) => {
    await pool.query('CREATE TABLE hooked_rows (id serial PRIMARY KEY, label text NOT NULL)');
  },
  client: (pool) => ({ pool }),
  seed: async ({ pool }) => {
    await pool.query("INSERT INTO hooked_rows (label) VALUES ('seed')");
  },
});

// Opt-out: no hooks — this file drives (and tears down) the context itself.
const manual = await setupPGlitePool({
  registerHooks: false,
  setup: async ({ pool }) => {
    await pool.query('CREATE TABLE manual_rows (id serial PRIMARY KEY, label text NOT NULL)');
  },
  client: (pool) => ({ pool }),
  seed: async ({ pool }) => {
    await pool.query("INSERT INTO manual_rows (label) VALUES ('seed')");
  },
});

afterAll(() => manual.close());

describe('setupPGlitePool — default hook registration', () => {
  it('returns the full pool context', () => {
    expect(hooked.pool).toBeInstanceOf(PgBridgePool);
    expect(hooked.client.pool).toBe(hooked.pool);
    expect(hooked.pglite).toBe(hooked.pool.pglite);
    expect(hooked.resetDb).toBeTypeOf('function');
    expect(hooked.snapshotDb).toBeTypeOf('function');
    expect(hooked.close).toBeTypeOf('function');
  });

  it('starts from the seed, then mutates', async () => {
    expect(await labels(hooked.pool, 'hooked_rows')).toEqual(['seed']);
    await hooked.pool.query("INSERT INTO hooked_rows (label) VALUES ('mutation')");
    expect(await labels(hooked.pool, 'hooked_rows')).toEqual(['seed', 'mutation']);
  });

  it('is reset to the seeded snapshot by the registered beforeEach', async () => {
    expect(await labels(hooked.pool, 'hooked_rows')).toEqual(['seed']);
  });
});

describe('setupPGlitePool — registerHooks: false', () => {
  it('starts from the seed, then mutates', async () => {
    expect(await labels(manual.pool, 'manual_rows')).toEqual(['seed']);
    await manual.pool.query("INSERT INTO manual_rows (label) VALUES ('mutation')");
  });

  it('does not reset between tests; a manual resetDb restores the seed', async () => {
    expect(await labels(manual.pool, 'manual_rows')).toEqual(['seed', 'mutation']);
    await manual.resetDb();
    expect(await labels(manual.pool, 'manual_rows')).toEqual(['seed']);
  });
});

const fileTest = createPoolTest({
  setup: async ({ pool }) => {
    await pool.query('CREATE TABLE file_rows (id serial PRIMARY KEY, label text NOT NULL)');
  },
  client: (pool) => ({ pool }),
  seed: async ({ pool }) => {
    await pool.query("INSERT INTO file_rows (label) VALUES ('seed')");
  },
});

describe('createPoolTest — file scope (default)', () => {
  fileTest(
    'starts from the seed with client wired to the pool fixture',
    async ({ client, pool }) => {
      expect(client.pool).toBe(pool);
      expect(await labels(pool, 'file_rows')).toEqual(['seed']);
      await pool.query("INSERT INTO file_rows (label) VALUES ('mutation')");
    },
  );

  fileTest('taking only pool does not reset the shared context', async ({ pool }) => {
    expect(await labels(pool, 'file_rows')).toEqual(['seed', 'mutation']);
  });

  fileTest('taking client resets back to the seeded snapshot', async ({ client }) => {
    expect(await labels(client.pool, 'file_rows')).toEqual(['seed']);
  });
});

const isolatedTest = createPoolTest({
  scope: 'test',
  setup: async ({ pool }) => {
    await pool.query('CREATE TABLE iso_rows (id serial PRIMARY KEY, label text NOT NULL)');
  },
  client: (pool) => ({ pool }),
  seed: async ({ pool }) => {
    await pool.query("INSERT INTO iso_rows (label) VALUES ('seed')");
  },
});

// A shared context would leak the sibling's insert into the 150ms overlap
// window; per-test isolation keeps each view at seed + own row, no reset.
describe('createPoolTest — test scope is safe for test.concurrent', () => {
  isolatedTest.concurrent('concurrent test A sees only its own insert', async ({ client }) => {
    await client.pool.query("INSERT INTO iso_rows (label) VALUES ('from-a')");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await labels(client.pool, 'iso_rows')).toEqual(['seed', 'from-a']);
  });

  isolatedTest.concurrent('concurrent test B sees only its own insert', async ({ client }) => {
    await client.pool.query("INSERT INTO iso_rows (label) VALUES ('from-b')");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await labels(client.pool, 'iso_rows')).toEqual(['seed', 'from-b']);
  });
});

describe('createPoolTest — API creation', () => {
  it('returns a test API without running any setup', () => {
    const setup = vi.fn(async () => {});
    const client = vi.fn((pool: PgBridgePool) => ({ pool }));
    const poolTest = createPoolTest({ setup, client });
    expect(poolTest).toBeTypeOf('function');
    // Setup (pool, table, client, seed, snapshot) is per-scope work that
    // happens lazily at test time — creating the test API must not run it.
    expect(setup).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });
});

// Type-level pin mirroring vitest.test.ts: the public fixture surface must
// expose exactly pool/client, with `client` carrying the caller's client
// type. tsc enforces these (test files are in the type-check include).
describe('createPoolTest public type surface', () => {
  interface FakeClient {
    readonly tag: 'fake';
  }

  it('exposes only pool/client, with client typed as the caller client', () => {
    const poolTest = createPoolTest<FakeClient>({
      setup: async () => {},
      client: () => ({ tag: 'fake' }),
      scope: 'test',
    });
    expectTypeOf(poolTest).toEqualTypeOf<TestAPI<PoolTestFixtures<FakeClient>>>();
    expectTypeOf<PoolTestFixtures<FakeClient>['client']>().toEqualTypeOf<FakeClient>();
    expectTypeOf<PoolTestFixtures<FakeClient>['pool']>().toEqualTypeOf<PgBridgePool>();
  });
});
