/**
 * MikroORM — the official `@mikro-orm/pglite` driver (user-owned instance
 * via `driverOptions.pglite`; the driver neuters its close on
 * `orm.close()`) vs the postgresql driver handed a kysely
 * `PostgresDialect` wrapping `PgBridgePool` through `driverOptions`
 * (structural `createDriver` check in AbstractSqlConnection, so the
 * dialect may come from any kysely copy).
 *
 * `orm.close()` on the wire path destroys the kysely client, which ENDS
 * the pool — the harness guards its own `pool.end()` with `pool.ended`.
 *
 * Unlike the query builders, MikroORM is an entity ORM: ops fork the
 * EntityManager per call (the request-scoped pattern), so both paths pay
 * the same identity-map and hydration cost.
 */
import { EntitySchema, type MikroORM } from '@mikro-orm/core';
import { MikroORM as PgliteMikroORM } from '@mikro-orm/pglite';
import { MikroORM as PostgresMikroORM } from '@mikro-orm/postgresql';
import { PostgresDialect } from 'kysely';
import type { OrmDefinition, OrmOps } from './types.ts';

interface UserEntity {
  id: number;
  name: string;
  email: string;
}

interface PostEntity {
  id: number;
  user?: UserEntity | null;
  title: string;
}

const User = new EntitySchema<UserEntity>({
  name: 'User',
  tableName: 'users',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    name: { type: 'string' },
    email: { type: 'string' },
  },
});

const Post = new EntitySchema<PostEntity>({
  name: 'Post',
  tableName: 'posts',
  properties: {
    id: { type: 'number', primary: true, autoincrement: true },
    user: { kind: 'm:1', entity: () => User, fieldName: 'user_id', nullable: true },
    title: { type: 'string' },
  },
});

const ENTITIES = [User, Post];

const makeOps = (orm: MikroORM): OrmOps => ({
  insertUser: async (name, email) => {
    await orm.em.fork().insert(User, { name, email });
  },
  insertPost: async (userId, title) => {
    await orm.em.fork().insert(Post, { user: userId, title } as never);
  },
  userIdByEmail: async (email) => {
    const row = await orm.em.fork().findOne(User, { email }, { fields: ['id'] });
    return row?.id;
  },
  usersAll: async () => orm.em.fork().find(User, {}),
  usersByEmail: async (email) => orm.em.fork().find(User, { email }, { fields: ['name', 'email'] }),
  usersLimit: async (n) => orm.em.fork().find(User, {}, { limit: n }),
  postsJoinUsers: async () =>
    orm.em.fork().find(Post, {}, { populate: ['user'], strategy: 'joined' }),
  txReadWrite: async (email, title) => {
    await orm.em.fork().transactional(async (em) => {
      const u = await em.findOne(User, { email });
      // em.create registers the new entity for persistence; the
      // transactional wrapper flushes on commit.
      if (u) em.create(Post, { user: u, title });
    });
  },
});

export const mikroOrm: OrmDefinition = {
  name: 'mikro-orm',
  nativeLabel: '@mikro-orm/pglite (official)',
  wireLabel: '@mikro-orm/postgresql + PgBridgePool (kysely dialect)',
  createNative: async (pglite) => {
    const orm = await PgliteMikroORM.init({
      entities: ENTITIES,
      dbName: 'postgres',
      driverOptions: { pglite },
    });
    return { ops: makeOps(orm), end: () => orm.close() };
  },
  createWire: async (pool) => {
    const orm = await PostgresMikroORM.init({
      entities: ENTITIES,
      dbName: 'postgres',
      driverOptions: new PostgresDialect({ pool }),
    });
    return { ops: makeOps(orm), end: () => orm.close() };
  },
};
