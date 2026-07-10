/**
 * Drizzle ORM — native `drizzle-orm/pglite` vs `drizzle-orm/node-postgres`
 * on `PgBridgePool`. First vendored from the 2026-07-09 /tmp spike that
 * motivated pool-level statement caching (ADR 001).
 */
import { eq } from 'drizzle-orm';
import { drizzle as makeWire } from 'drizzle-orm/node-postgres';
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core';
import { drizzle as makeNative } from 'drizzle-orm/pglite';
import type { OrmDefinition, OrmOps } from './types.ts';

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
});

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  title: text('title').notNull(),
});

type Db = ReturnType<typeof makeNative>;

const makeOps = (db: Db): OrmOps => ({
  insertUser: async (name, email) => {
    await db.insert(users).values({ name, email });
  },
  insertPost: async (userId, title) => {
    await db.insert(posts).values({ userId, title });
  },
  userIdByEmail: async (email) => {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
    return row?.id;
  },
  usersAll: async () => db.select().from(users),
  usersByEmail: async (email) =>
    db.select({ name: users.name, email: users.email }).from(users).where(eq(users.email, email)),
  usersLimit: async (n) => db.select().from(users).limit(n),
  postsJoinUsers: async () =>
    db
      .select({ postId: posts.id, title: posts.title, author: users.name })
      .from(posts)
      .leftJoin(users, eq(posts.userId, users.id)),
  txReadWrite: async (email, title) => {
    await db.transaction(async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (u?.id) await tx.insert(posts).values({ userId: u.id, title });
    });
  },
});

export const drizzle: OrmDefinition = {
  name: 'drizzle',
  nativeLabel: 'drizzle-orm/pglite',
  wireLabel: 'drizzle-orm/node-postgres + PgBridgePool',
  createNative: (pglite) => ({
    ops: makeOps(makeNative(pglite)),
    end: async () => {},
  }),
  createWire: (pool) => ({
    // NodePgDatabase and PgliteDatabase expose the same query-builder
    // surface for every call in OrmOps; collapse to one Db type here.
    ops: makeOps(makeWire(pool) as unknown as Db),
    end: async () => {},
  }),
};
