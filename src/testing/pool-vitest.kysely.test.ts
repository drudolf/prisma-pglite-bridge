/**
 * Real-ORM integration for the pool testing helpers (red-first — the
 * modules under test do not exist yet): kysely's `PostgresDialect` and
 * drizzle's node-postgres driver both consume the `pg.Pool` surface that
 * `PgBridgePool` extends, so `createPoolContext` and `createPoolTest`
 * must carry their connect/query/transaction/end flows end-to-end.
 * Kysely's `destroy()` ends the pool through the dialect, exercising the
 * tolerated dispose-ends-the-pool path of the core contract with a real
 * client. Wiring recipes mirror benchmark/orm/{kysely,drizzle}.ts.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { pgTable, serial, text } from 'drizzle-orm/pg-core';
import { type Generated, Kysely, PostgresDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPoolContext, type PGlitePoolTestContext } from './pool-core.ts';
import { createPoolTest } from './pool-vitest.ts';

interface Database {
  users: {
    id: Generated<number>;
    name: string;
    email: string;
  };
}

const seedUsers = [
  { name: 'Ada', email: 'ada@example.com' },
  { name: 'Grace', email: 'grace@example.com' },
];

const userNames = async (db: Kysely<Database>): Promise<string[]> => {
  const rows = await db.selectFrom('users').select('name').orderBy('id').execute();
  return rows.map((row) => row.name);
};

describe('createPoolContext + kysely PostgresDialect on PgBridgePool', () => {
  let ctx: PGlitePoolTestContext<Kysely<Database>>;

  beforeAll(async () => {
    ctx = await createPoolContext<Kysely<Database>>({
      setup: async ({ pool }) => {
        await pool.query(
          'CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, email text NOT NULL)',
        );
      },
      client: (pool) => new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
      seed: async (db) => {
        await db.insertInto('users').values(seedUsers).execute();
      },
      // destroy() ends the pool via the dialect — the core contract
      // tolerates a dispose that does exactly that.
      dispose: (db) => db.destroy(),
    });
  });

  afterAll(() => ctx.close());

  it('reads the kysely-inserted seed back through kysely', async () => {
    const rows = await ctx.client
      .selectFrom('users')
      .select(['name', 'email'])
      .orderBy('id')
      .execute();
    expect(rows).toEqual(seedUsers);
  });

  it('mutates through kysely, then resetDb restores the seed', async () => {
    await ctx.client.deleteFrom('users').where('name', '=', 'Ada').execute();
    await ctx.client
      .insertInto('users')
      .values({ name: 'Mallory', email: 'mallory@example.com' })
      .execute();
    expect(await userNames(ctx.client)).toEqual(['Grace', 'Mallory']);

    await ctx.resetDb();

    expect(await userNames(ctx.client)).toEqual(['Ada', 'Grace']);
  });

  it('runs a kysely transaction end-to-end', async () => {
    await ctx.client.transaction().execute(async (trx) => {
      await trx.insertInto('users').values({ name: 'Tx', email: 'tx@example.com' }).execute();
    });
    expect(await userNames(ctx.client)).toEqual(['Ada', 'Grace', 'Tx']);
  });
});

const kyselyTest = createPoolTest<Kysely<Database>>({
  setup: async ({ pool }) => {
    await pool.query(
      'CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL, email text NOT NULL)',
    );
  },
  client: (pool) => new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
  seed: async (db) => {
    await db.insertInto('users').values(seedUsers).execute();
  },
  dispose: (db) => db.destroy(),
});

describe('createPoolTest + kysely', () => {
  kyselyTest('starts from the kysely seed, then mutates', async ({ client }) => {
    expect(await userNames(client)).toEqual(['Ada', 'Grace']);
    await client
      .insertInto('users')
      .values({ name: 'Mallory', email: 'mallory@example.com' })
      .execute();
    expect(await userNames(client)).toEqual(['Ada', 'Grace', 'Mallory']);
  });

  kyselyTest('is reset to the kysely seed before the next test', async ({ client }) => {
    expect(await userNames(client)).toEqual(['Ada', 'Grace']);
  });
});

const dUsers = pgTable('d_users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
});

describe('drizzle spot check — drizzle-orm/node-postgres on PgBridgePool', () => {
  let ctx: PGlitePoolTestContext<NodePgDatabase>;

  beforeAll(async () => {
    ctx = await createPoolContext<NodePgDatabase>({
      setup: async ({ pool }) => {
        await pool.query('CREATE TABLE d_users (id serial PRIMARY KEY, name text NOT NULL)');
      },
      client: (pool) => drizzle(pool),
      seed: async (db) => {
        await db.insert(dUsers).values({ name: 'Ada' });
      },
    });
  });

  afterAll(() => ctx.close());

  it('inserts and selects through drizzle, and resetDb restores the seed', async () => {
    await ctx.client.insert(dUsers).values({ name: 'Grace' });
    const mutated = await ctx.client.select({ name: dUsers.name }).from(dUsers).orderBy(dUsers.id);
    expect(mutated.map((row) => row.name)).toEqual(['Ada', 'Grace']);

    await ctx.resetDb();

    const restored = await ctx.client.select({ name: dUsers.name }).from(dUsers).orderBy(dUsers.id);
    expect(restored.map((row) => row.name)).toEqual(['Ada']);
  });
});
