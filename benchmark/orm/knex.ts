/**
 * Knex — community `knex-pglite` dialect vs the pg dialect handed a
 * `PgBridgePool` through knex ≥ 3.3.0's `connectionPool` option (knex
 * does not own the pool; `destroy()` releases the reference only).
 *
 * Wire-path note: knex's pg dialect issues object-form queries with a
 * positional callback, so this module exercises the bridge's callback
 * re-entry dispatch. Native-path note: knex-pglite closes even a
 * caller-supplied PGlite instance on `destroy()` — the harness guards
 * its own close with `pglite.closed`.
 */
import makeKnex from 'knex';
import ClientPgLite from 'knex-pglite';
import type { OrmDefinition, OrmOps } from './types.ts';

type Db = ReturnType<typeof makeKnex>;

const makeOps = (db: Db): OrmOps => ({
  insertUser: async (name, email) => {
    await db('users').insert({ name, email });
  },
  insertPost: async (userId, title) => {
    await db('posts').insert({ user_id: userId, title });
  },
  userIdByEmail: async (email) => {
    const row = await db('users').select('id').where('email', email).first();
    return row?.id;
  },
  usersAll: async () => db('users').select('*'),
  usersByEmail: async (email) => db('users').select('name', 'email').where('email', email),
  usersLimit: async (n) => db('users').select('*').limit(n),
  postsJoinUsers: async () =>
    db('posts')
      .leftJoin('users', 'users.id', 'posts.user_id')
      .select('posts.id as postId', 'posts.title', 'users.name as author'),
  txReadWrite: async (email, title) => {
    await db.transaction(async (trx) => {
      const u = await trx('users').select('id').where('email', email).first();
      if (u?.id) await trx('posts').insert({ user_id: u.id, title });
    });
  },
});

export const knex: OrmDefinition = {
  name: 'knex',
  nativeLabel: 'knex-pglite (community dialect)',
  wireLabel: 'knex pg dialect + PgBridgePool (connectionPool)',
  createNative: (pglite) => {
    const db = makeKnex({
      client: ClientPgLite,
      dialect: 'postgres',
      // knex-pglite's documented (experimental, untyped) hook for an
      // existing instance: a connection function returning { pglite }.
      connection: () => ({ pglite }) as never,
    });
    return { ops: makeOps(db), end: async () => db.destroy() };
  },
  createWire: (pool) => {
    const db = makeKnex({ client: 'pg', connectionPool: pool });
    return { ops: makeOps(db), end: async () => db.destroy() };
  },
};
