# prisma-pglite-bridge — agent guide

This file is for agents working in projects that **use**
`prisma-pglite-bridge`. For contributing to the bridge itself, see
`CLAUDE.md` in the repository. Everything below is also in the bundled
docs: `docs/api.md` (surface), `docs/cookbook.md` (recipes),
`docs/troubleshooting.md` (errors, warnings, limits), `docs/server.md`
(`PGliteServer`), `docs/stats.md`, `docs/compatibility.md` — all
readable from `node_modules/prisma-pglite-bridge/`.

## What it is

An in-process PostgreSQL for tests: PGlite (Postgres compiled to WASM)
behind the real `pg` client and the official `@prisma/adapter-pg`. No
Docker, no server, no network. Requires Node ≥ 22 and Prisma 7.

## Entry points

| Import | Use when |
| --- | --- |
| `prisma-pglite-bridge` | Building blocks: `PGliteBridge`, `pushMigrations`, `pushSchema`, `hasSchema`, `PGliteServer`, `PgBridgeError` |
| `prisma-pglite-bridge/vitest` | Prisma + vitest: `createBridgeTest` (fixtures), `setupPGliteBridge` (one call) |
| `prisma-pglite-bridge/jest` | Prisma + Jest (native ESM): `setupPGliteBridge` |
| `prisma-pglite-bridge/pool` | No Prisma: `PgBridgePool` is a `pg.Pool` for drizzle, kysely, knex, typeorm, mikro-orm |
| `prisma-pglite-bridge/pool/vitest` | Any ORM + vitest: `createPoolTest`, `setupPGlitePool` |
| `prisma-pglite-bridge/pool/jest` | Any ORM + Jest: `setupPGlitePool` |

## Recipes

Prisma + vitest (`docs/cookbook.md` → "Vitest: one call or fixtures"):

```ts
import { PrismaClient } from '@prisma/client'; // prisma-client generator: import from its `output` path
import { createBridgeTest } from 'prisma-pglite-bridge/vitest';
import { expect } from 'vitest';

const test = createBridgeTest({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true, // or { migrationsPath: './prisma/migrations' }, or schema: { schema }
  seed: async (prisma) => { await prisma.user.create({ data: { email: 'a@x.io', name: 'A' } }); },
});

test('starts seeded', async ({ prisma }) => {
  expect(await prisma.user.count()).toBe(1); // reset to the seeded snapshot before every test
});
```

Any ORM + vitest (`docs/cookbook.md` → "Testing with any ORM"):

```ts
import { createPoolTest } from 'prisma-pglite-bridge/pool/vitest';
import { Kysely, PostgresDialect } from 'kysely';

const test = createPoolTest({
  setup: async ({ pool }) => { await pool.query('CREATE TABLE users (id serial PRIMARY KEY, name text)'); },
  client: (pool) => new Kysely<DB>({ dialect: new PostgresDialect({ pool }) }),
  seed: async (db) => { await db.insertInto('users').values({ name: 'Ada' }).execute(); },
  dispose: (db) => db.destroy(),
});
```

Jest (`docs/cookbook.md` → "Jest: one call"; needs
`NODE_OPTIONS=--experimental-vm-modules`):

```ts
import { PrismaClient } from '@prisma/client';
import { setupPGliteBridge } from 'prisma-pglite-bridge/jest';
const { prisma } = await setupPGliteBridge({ client: (adapter) => new PrismaClient({ adapter }), migrations: true });
```

App in a separate process (Playwright, Next.js, supertest against a
spawned server): `docs/cookbook.md` → "End-to-end: run your app against
the bridge" (`PGliteServer` + `DATABASE_URL`); reset between tests with
`server.resetDb()` (data only; connection state persists).

## Rules of thumb

- Exactly one of `migrations` / `schema` per helper call; `migrations:
  true` needs `prisma.config.ts` and the optional `@prisma/config` peer.
- Fixture tests must take `prisma` (or `client`) to get the per-test
  reset; taking only `bridge` / `pool` does not reset.
- `test.concurrent` is safe only with `scope: 'test'`.
- `resetDb()` / `snapshotDb()` need an idle pool: await every query and
  end open transactions first.
- `pushMigrations` with a migrations directory is idempotent
  (Prisma-compatible `_prisma_migrations` bookkeeping; `migrate status`
  sees it); guard only `pushSchema` and `pushMigrations({ sql })` with
  `hasSchema` on a persistent `dataDir`.
- A failing vitest test prints the SQL it ran (query trail) to stderr.
  `PGLITE_BRIDGE_QUERY_TRAIL=0` disables it; `PGLITE_BRIDGE_TRAIL_FORMAT=json`
  switches to JSONL; `queryTrail: { redactParams: true }` hides params.
- Node prints `ExperimentalWarning` for WASM on `pushSchema`; silence with
  `NODE_OPTIONS=--disable-warning=ExperimentalWarning`.

## Errors (`PgBridgeError`, match on `.code`)

Full table with triggers: `docs/api.md` → "Errors: PgBridgeError".
Every error and warning message ends with
`(docs: prisma-pglite-bridge/docs/troubleshooting.md#<code>)`; `error.docs`
carries the same pointer.

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_PG_INTERNALS` | installed `pg` lacks the internals the bridge drives — `docs/troubleshooting.md` → "Unsupported pg internals" |
| `BRIDGE_OPTIONS_REQUIRED` | two `pg` copies installed (adapter and bridge resolve different ones) — `pnpm why pg`, dedupe; or `PgBridgeClient` constructed outside `PgBridgePool` |
| `POOL_NOT_IDLE` | `resetDb` / `snapshotDb` while a client is checked out |
| `INVALID_STATS_LEVEL` | `statsLevel` not `'off'` / `'basic'` / `'full'` |
| `SERVER_CLOSED` | `PGliteServer.listen()` after `close()` |
| `SERVER_PGLITE_CLOSED` | server given an already-closed PGlite |
| `SERVER_NOT_IDLE` | `PGliteServer.resetDb/snapshotDb` while a connection is in a transaction or still busy past `timeoutMs` |
| `PGLITE_CLOSED` | the PGlite instance was closed under a live bridge |
| `PGLITE_NOT_READY` | PGlite never became ready (readiness timeout) |
| `MIGRATIONS_UNAVAILABLE` | no `sql`, no `migration.sql` files, no loadable `prisma.config.ts` |
| `MIGRATIONS_APPLY_FAILED` | schema SQL failed; PGlite error in `cause` |
| `MIGRATIONS_HISTORY_INVALID` | failed, duplicate, orphaned, or modified migration in `_prisma_migrations`, or tables without history — message names the `prisma migrate resolve` repair |
| `SNAPSHOT_INVALID` | schema changed since `snapshotDb()` — snapshot again |

Warnings (`process.emitWarning`, by `name`):
`PGliteBridgeAbandonedTransactionWarning` (client released mid-transaction;
auto-rolled back — `docs/troubleshooting.md`),
`PGliteBridgeSharedInstanceWarning` (several pools on one PGlite; their
transactions can interleave), `PGliteBridgeLeakWarning` (a bridge or
pool was never closed).

## Foot-guns

- Two copies of `pg` (bridge extends one, adapter uses the other) fail
  with `UNSUPPORTED_PG_INTERNALS` or `BRIDGE_OPTIONS_REQUIRED`; a second,
  older `@electric-sql/pglite` copy fails with `execProtocolRawStream is
  not a function` (`docs/troubleshooting.md`). Deduplicate with a pnpm
  override / `npm dedupe`.
- One PostgreSQL session per PGlite: all connections serialize; `SET`
  leaks between clients within a test; no roles, no parallel queries.
- WASM cold start is ~0.5–2 s per PGlite; `scope: 'file'` pays it per
  file, `'worker'` once per worker, `'test'` once per file via a template.
