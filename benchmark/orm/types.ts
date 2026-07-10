/**
 * Contract between the ORM benchmark harness (`run.ts`) and each ORM
 * module. The harness owns the workload — schema DDL, seeding, warmup,
 * correctness gate, timing, reporting — so every ORM measures the same
 * operations. An ORM module only translates each operation into its own
 * query-builder API, once per path:
 *
 *   native — the ORM's own PGlite driver (calls the PGlite JS API directly)
 *   wire   — the ORM's node-postgres driver on `PgBridgePool`
 *
 * Adding an ORM: implement `OrmDefinition` in a sibling file, register it
 * in `run.ts`'s `ORMS` map, add the ORM as a devDependency.
 */
import type { PGlite } from '@electric-sql/pglite';
import type { PgBridgePool } from '../../src/pool';

/** The measured operations, one method per SQL shape the harness times. */
export type OrmOps = {
  /** INSERT one user. */
  insertUser(name: string, email: string): Promise<unknown>;
  /** INSERT one post for a user id. */
  insertPost(userId: number, title: string): Promise<unknown>;
  /** SELECT the id of the user with this email. */
  userIdByEmail(email: string): Promise<number | undefined>;
  /** SELECT * FROM users. */
  usersAll(): Promise<unknown>;
  /** SELECT name, email FROM users WHERE email = $1. */
  usersByEmail(email: string): Promise<Array<{ name: string; email: string }>>;
  /** SELECT * FROM users LIMIT n — the warmup read shape. */
  usersLimit(n: number): Promise<unknown>;
  /** posts LEFT JOIN users: post id, title, author name. */
  postsJoinUsers(): Promise<Array<{ title: string | null }>>;
  /** One transaction: SELECT the user id by email, INSERT a post for it. */
  txReadWrite(email: string, title: string): Promise<unknown>;
};

/** One configured path. `end()` releases ORM-side resources only — the
 *  harness owns and closes the PGlite instances and the bridge pool. */
type OrmPath = {
  ops: OrmOps;
  end(): Promise<void>;
};

export type OrmDefinition = {
  /** Registry key and report heading, e.g. 'drizzle'. */
  name: string;
  /** Label for the native path, e.g. 'drizzle-orm/pglite'. */
  nativeLabel: string;
  /** Label for the wire path, e.g. 'drizzle-orm/node-postgres + PgBridgePool'. */
  wireLabel: string;
  createNative(pglite: PGlite): OrmPath | Promise<OrmPath>;
  createWire(pool: PgBridgePool): OrmPath | Promise<OrmPath>;
};
