/**
 * Kysely — the built-in `PGliteDialect` (first-party since kysely 0.29)
 * vs `PostgresDialect` handed a `PgBridgePool`. Both paths are the same
 * `Kysely<Database>` type, so one ops factory serves both without casts.
 */
import type { Generated } from 'kysely';
import { Kysely, PGliteDialect, PostgresDialect } from 'kysely';
import type { OrmDefinition, OrmOps } from './types.ts';

interface Database {
  users: { id: Generated<number>; name: string; email: string };
  posts: { id: Generated<number>; user_id: number | null; title: string };
}

const makeOps = (db: Kysely<Database>): OrmOps => ({
  insertUser: async (name, email) => {
    await db.insertInto('users').values({ name, email }).execute();
  },
  insertPost: async (userId, title) => {
    await db.insertInto('posts').values({ user_id: userId, title }).execute();
  },
  userIdByEmail: async (email) => {
    const row = await db
      .selectFrom('users')
      .select('id')
      .where('email', '=', email)
      .executeTakeFirst();
    return row?.id;
  },
  usersAll: async () => db.selectFrom('users').selectAll().execute(),
  usersByEmail: async (email) =>
    db.selectFrom('users').select(['name', 'email']).where('email', '=', email).execute(),
  usersLimit: async (n) => db.selectFrom('users').selectAll().limit(n).execute(),
  postsJoinUsers: async () =>
    db
      .selectFrom('posts')
      .leftJoin('users', 'users.id', 'posts.user_id')
      .select(['posts.id as postId', 'posts.title', 'users.name as author'])
      .execute(),
  txReadWrite: async (email, title) => {
    await db.transaction().execute(async (trx) => {
      const u = await trx
        .selectFrom('users')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst();
      if (u?.id) await trx.insertInto('posts').values({ user_id: u.id, title }).execute();
    });
  },
});

export const kysely: OrmDefinition = {
  name: 'kysely',
  nativeLabel: 'kysely PGliteDialect (built-in)',
  wireLabel: 'kysely PostgresDialect + PgBridgePool',
  createNative: (pglite) => ({
    ops: makeOps(new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) })),
    end: async () => {},
  }),
  createWire: (pool) => ({
    ops: makeOps(new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })),
    end: async () => {},
  }),
};
