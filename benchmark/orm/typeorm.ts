/**
 * TypeORM — community `typeorm-pglite` driver vs a hand-rolled driver
 * shim over `PgBridgePool`.
 *
 * Native path: typeorm-pglite keeps a module-level PGlite SINGLETON built
 * from constructor options and never accepts an existing instance — the
 * harness-owned instance is injected straight into the singleton via a
 * deep import (`PGliteInstance.instance` is a plain public static; no
 * exports map blocks the path). Its pool `end()` closes that instance and
 * resets the singleton — the harness's `pglite.closed` guard covers it.
 *
 * Wire path: TypeORM has no external-pool seam, but `options.driver`
 * replaces the whole `pg` module and PostgresDriver only ever calls
 * `new this.postgres.Pool(options)` on it (plus a `native` probe) — a
 * constructor returning the existing `PgBridgePool` satisfies that, since
 * a JS constructor returning an object overrides `this`. TypeORM ends the
 * pool on `destroy()`; the harness's `pool.ended` guard covers it.
 */
import { DataSource, EntitySchema } from 'typeorm';
import { PGliteDriver } from 'typeorm-pglite';
import { PGliteInstance } from 'typeorm-pglite/dist/pglite-instance';
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
  columns: {
    id: { type: Number, primary: true, generated: true },
    name: { type: String },
    email: { type: String },
  },
});

const Post = new EntitySchema<PostEntity>({
  name: 'Post',
  tableName: 'posts',
  columns: {
    id: { type: Number, primary: true, generated: true },
    title: { type: String },
  },
  relations: {
    user: {
      type: 'many-to-one',
      target: 'User',
      joinColumn: { name: 'user_id' },
      nullable: true,
    },
  },
});

const ENTITIES = [User, Post];

const makeOps = (ds: DataSource): OrmOps => {
  const users = ds.getRepository(User);
  const posts = ds.getRepository(Post);
  return {
    insertUser: async (name, email) => {
      await users.insert({ name, email });
    },
    insertPost: async (userId, title) => {
      await posts.insert({ user: { id: userId }, title } as never);
    },
    userIdByEmail: async (email) => {
      const row = await users.findOne({ where: { email }, select: { id: true } });
      return row?.id;
    },
    usersAll: async () => users.find(),
    usersByEmail: async (email) =>
      users.find({ where: { email }, select: { name: true, email: true } }),
    usersLimit: async (n) => users.find({ take: n }),
    postsJoinUsers: async () =>
      posts.createQueryBuilder('p').leftJoinAndSelect('p.user', 'u').getMany(),
    txReadWrite: async (email, title) => {
      await ds.transaction(async (em) => {
        const u = await em.findOne(User, { where: { email } });
        if (u) await em.insert(Post, { user: { id: u.id }, title } as never);
      });
    },
  };
};

export const typeorm: OrmDefinition = {
  name: 'typeorm',
  nativeLabel: 'typeorm-pglite (community driver)',
  wireLabel: 'typeorm postgres driver-shim + PgBridgePool',
  createNative: async (pglite) => {
    const driver = new PGliteDriver({}).driver;
    (PGliteInstance as unknown as { instance: unknown }).instance = pglite;
    const ds = new DataSource({
      type: 'postgres',
      driver,
      entities: ENTITIES,
      synchronize: false,
    });
    await ds.initialize();
    return { ops: makeOps(ds), end: () => ds.destroy().then(() => {}) };
  },
  createWire: async (pool) => {
    const driverShim = {
      Pool: function PoolShim() {
        return pool;
      },
    };
    const ds = new DataSource({
      type: 'postgres',
      driver: driverShim,
      database: 'postgres',
      entities: ENTITIES,
      synchronize: false,
    });
    await ds.initialize();
    return { ops: makeOps(ds), end: () => ds.destroy().then(() => {}) };
  },
};
