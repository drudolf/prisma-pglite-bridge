# Cookbook

End-to-end examples for common test setups and dev workflows.
For the underlying API, see the [API reference](./api.md).

## Contents

- [Testing](#testing)
  - [Vitest: one call or fixtures](#vitest-one-call-or-fixtures)
  - [Jest: one call](#jest-one-call)
  - [Choosing an isolation model](#choosing-an-isolation-model)
  - [Wiring the bridge into your app](#wiring-the-bridge-into-your-app)
  - [Schema and seed](#schema-and-seed)
- [Other ORMs](#other-orms)
  - [Wiring recipes](#wiring-recipes)
  - [Testing with any ORM](#testing-with-any-orm)
- [Local development and scripts](#local-development-and-scripts)
  - [Persistent database](#persistent-database)
  - [Dev server for Studio, psql, and the CLI](#dev-server-for-studio-psql-and-the-cli)
  - [Long-running script with clean shutdown](#long-running-script-with-clean-shutdown)

## Testing

Reach for the one-call helper from `prisma-pglite-bridge/vitest` (or
`/jest`) first — it collapses bridge, migrations, seed, snapshot, and
lifecycle hooks into a single call. The building blocks it wraps
(`PGliteBridge`, `pushMigrations`, `resetDb`) are used directly in the
later sections for custom wiring (`vi.mock`) and other runners.

### Vitest: one call or fixtures

`setupPGliteBridge` returns a seeded, snapshot-backed client and
registers the lifecycle hooks:

```typescript
// tests/db.test.ts (or a setupFiles entry — hooks then apply per worker)
import { PrismaClient } from '@prisma/client';
import { setupPGliteBridge } from 'prisma-pglite-bridge/vitest';

const { prisma } = await setupPGliteBridge({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true, // auto-discovers prisma/migrations via prisma.config.ts
  seed: async (prisma) => {
    await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  },
});

test('starts from the seeded snapshot', async () => {
  expect(await prisma.tenant.count()).toBe(1);
});
```

Every test starts from the seeded snapshot (`beforeEach` reset) and the
WASM instance is closed when the file finishes (`afterAll`). Options:
`schema` applies an inline Prisma schema instead of migrations,
`snapshot: false` makes resets truncate to empty, and
`registerHooks: false` hands the lifecycle back to you — see the
[API reference](./api.md).

**Fixtures (`createBridgeTest`)** wrap the same flow in vitest's
[test context](https://vitest.dev/guide/test-context.html) — tests
declare what they need, typed, and vitest sequences setup and teardown:

```typescript
import { PrismaClient } from '@prisma/client';
import { createBridgeTest } from 'prisma-pglite-bridge/vitest';

const test = createBridgeTest({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  seed: async (prisma) => {
    await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  },
});

test('starts from the seeded snapshot', async ({ prisma }) => {
  expect(await prisma.tenant.count()).toBe(1);
});
```

Every test taking `prisma` starts from the seeded snapshot (the fixture
resets before handing it over); tests taking only `bridge` skip the
reset; tests taking neither skip the database entirely. Compose your own
fixtures on top with `test.extend`. Requires vitest ≥ 3.2 (fixture
scopes).

### Jest: one call

The same helper ships from the `prisma-pglite-bridge/jest` entry point
with identical options — one call sets up the bridge, migrations, seed,
and snapshot, and registers `beforeEach(resetDb)` + `afterAll(close)`,
wired to Jest's hooks:

```typescript
// tests/db.test.ts — run under Jest's native ESM mode
import { PrismaClient } from '@prisma/client';
import { setupPGliteBridge } from 'prisma-pglite-bridge/jest';

const { prisma } = await setupPGliteBridge({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true, // auto-discovers prisma/migrations via prisma.config.ts
  seed: async (prisma) => {
    await prisma.tenant.create({ data: { name: 'Acme', slug: 'acme' } });
  },
});

test('starts from the seeded snapshot', async () => {
  expect(await prisma.tenant.count()).toBe(1);
});
```

The top-level `await` requires Jest's [native ESM
mode](https://jestjs.io/docs/ecmascript-modules): run Jest with
`NODE_OPTIONS=--experimental-vm-modules` and an ESM-capable config.
`@jest/globals` is an optional peer dependency — install it alongside
`jest` if it is not already present. Jest has no fixture (`test.extend`)
equivalent, so there is no `createBridgeTest` on this entry; to swap a
shared production singleton, see [Wiring the bridge into your
app](#wiring-the-bridge-into-your-app).

### Choosing an isolation model

**The test file is the database boundary.** Each `setupPGliteBridge` or
`createBridgeTest` call creates its own bridge and its own in-memory
PGlite — so with Vitest's default `isolate: true`, every test file gets a
private database and files cannot interfere with each other. Within a
file, tests share that one instance and are isolated by the snapshot
reset between tests.

The trade-off dial:

- **One bridge per file (both APIs' default)** — maximum isolation; each
  file pays the cold start (WASM init + migrations + seed, roughly
  0.5–2s depending on hardware).
- **`createBridgeTest({ scope: 'worker', ... })`** — one warm bridge
  shared across all files a worker runs, with default isolation left ON:
  the cold start, migrations, and seed are paid once per worker, and the
  per-test snapshot reset still applies. All files in the worker share
  one seeded snapshot, so this fits projects with one global fixture set.
  (Uses vitest worker-scoped fixtures; on the `vmThreads`/`vmForks` pools
  these initialize per file, so the amortization applies to the default
  `threads`/`forks` pools.)
- **`createBridgeTest({ scope: 'test', ... })`** — a fresh, independent
  PGlite per test, the only configuration where `test.concurrent` is safe
  (each test owns its own session). Rather than repeat the full cold
  start every time, it builds one template per file (cold start +
  migrations + seed, paid once) and loads a fresh instance from it per
  test — several times cheaper per test (≈5× in the [isolation-cost
  benchmark](../benchmark/BENCHMARK.md#per-test-isolation-cost)) and far
  more predictable, with the seed running once. Each live instance keeps
  its own in-memory data directory, so many concurrent tests trade memory
  for isolation.
- **`setupPGliteBridge` in a `setupFiles` entry with `isolate: false`** —
  the pre-fixture equivalent of worker scope; still works, but
  `scope: 'worker'` achieves the same without giving up isolation. This
  mirrors the singleton pattern in [Wiring the bridge into your
  app](#wiring-the-bridge-into-your-app).

**Don't use `test.concurrent` with a shared context**: concurrent tests
would interleave on one single-session PGlite, and `resetDb` deliberately
throws while pool clients are checked out. The exception is
`createBridgeTest({ scope: 'test' })`, which gives every test its own
instance.

**Session hygiene without `resetDb`.** `resetDb()` already resets session
state between tests — `SET` variables, temp tables, cursors, `LISTEN`
registrations, and advisory locks (everything `DISCARD ALL` covers except
`DEALLOCATE ALL`, so named prepared statements stay cached). If you use a
bare `PgBridgePool` without the bridge's reset, run the reset yourself:

```typescript
await pool.query('DISCARD ALL');
```

The bridge evicts its statement caches across all clients automatically.
Two constraints, both consequences of the shared single session: issue it
only while the pool is otherwise fully idle (or at `max: 1` with no
concurrent checkout) — with other clients checked out it destroys *their*
session state too — and outside any open transaction, where the backend
rejects it.

### Wiring the bridge into your app

How your application code obtains its Prisma client decides how you plug
the bridge in — and whether you need `vi.mock` at all.

**If your code takes a `PrismaClient` as a parameter** (dependency
injection), just pass the client the helper returns — no mocking, no
hoisting concerns. The manual form, when you want one bridge per file
without the helper:

```typescript
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, it, expect } from 'vitest';

let prisma: PrismaClient;
let resetDb: PGliteBridge['resetDb'];

beforeAll(async () => {
  const bridge = new PGliteBridge();
  await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
  prisma = new PrismaClient({ adapter: bridge.adapter });
  resetDb = bridge.resetDb;
});

beforeEach(() => resetDb());

it('creates a user', async () => {
  const user = await prisma.user.create({ data: { name: 'Test' } });
  expect(user.id).toBeDefined();
});
```

Per file, migrations and seed re-run in every file's `beforeAll`; use the
shared setup file (below) once that cost matters.

**If your code imports a production singleton** (`import { prisma } from
'./lib/prisma'`), swap that module in tests so every import gets the
PGlite-backed client. Most projects have a singleton like:

```typescript
// lib/prisma.ts — your production singleton
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });
```

Build one bridge in a setup file and point the singleton at it —
migrations and seed run once, all tests share one snapshot, and
`resetDb()` runs before each:

```typescript
// vitest.setup.ts
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeEach, vi } from 'vitest';

const bridge = new PGliteBridge();
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
export const testPrisma = new PrismaClient({ adapter: bridge.adapter });

// `vi.mock` is hoisted above these lines, so `{ prisma: testPrisma }`
// would capture `testPrisma` before it is assigned. A getter defers the
// read until a test actually uses the client — by which point the setup
// file has finished. (An async factory that `await import`s a memoized
// bridge module is an equally robust, fully decoupled variant; that is
// what this repo's own integration tests use.)
vi.mock('./lib/prisma', () => ({
  get prisma() {
    return testPrisma;
  },
}));

beforeEach(() => bridge.resetDb());
```

```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
  },
});
```

Now every test file that imports `prisma` from `lib/prisma` gets the
PGlite-backed instance. No Docker, no test database, no cleanup scripts.

For Jest, the same pattern works with `jest.mock` (also hoisted — keep it
at the top level, not inside `beforeAll`):

```typescript
// jest.setup.ts
const { PGliteBridge, pushMigrations } = require('prisma-pglite-bridge');
const { PrismaClient } = require('@prisma/client');

let testPrisma;
let resetDb;

jest.mock('./lib/prisma', () => ({
  get prisma() { return testPrisma; },
}));

beforeAll(async () => {
  const bridge = new PGliteBridge();
  await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
  testPrisma = new PrismaClient({ adapter: bridge.adapter });
  resetDb = bridge.resetDb;
});

beforeEach(() => resetDb());
```

### Schema and seed

The building block behind the helpers is `pushMigrations` against a bare
bridge — the same call the sections above use:

```typescript
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';

const bridge = new PGliteBridge();
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });
```

`migrations: true` in the helpers auto-discovers this directory via
`prisma.config.ts`. The variations below swap the schema source or seed
step.

**No migrations directory.** For fixtures or prototypes, apply an inline
schema with `pushSchema` (the WASM schema engine) instead:

```typescript
import { readFile } from 'node:fs/promises';
import { PGliteBridge, pushSchema } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge();
await pushSchema(bridge.adapter, {
  schema: await readFile('prisma/schema.prisma', 'utf8'),
});
```

**Pre-generated SQL (fastest).** The `sql` option on `pushMigrations`
runs verbatim with no sandbox or checksum. Compose it from trusted,
version-controlled source only — never from environment variables,
network input, or values that cross a trust boundary.

```typescript
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge();
await pushMigrations(bridge.pglite, {
  sql: `
    CREATE TABLE "User" (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE "Post" (
      id text PRIMARY KEY,
      title text NOT NULL,
      "userId" text REFERENCES "User"(id)
    );
  `,
});
```

**PostgreSQL extensions.** If your schema uses `uuid-ossp`, `pgcrypto`,
or others, construct PGlite with the `extensions` option and pass it to
the bridge (caller-owned):

```typescript
import { PGlite } from '@electric-sql/pglite';
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const pglite = new PGlite({ extensions: { uuid_ossp, pgcrypto } });
const bridge = new PGliteBridge({ pglite }); // caller owns pglite
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
// remember to call pglite.close() alongside bridge.close() in teardown
```

Extensions ship inside the `@electric-sql/pglite` package — no extra
install. See [PGlite extensions](https://pglite.dev/extensions/) for the
full list.

**Sharing seed logic with `prisma db seed`.** Extract seed logic into a
function that accepts a `PrismaClient` and reuse it in both places:

```typescript
// prisma/seed.ts
import { PrismaClient } from '@prisma/client';

export const seed = async (prisma: PrismaClient) => {
  await prisma.user.create({ data: { name: 'Alice', role: 'ADMIN' } });
  await prisma.user.create({ data: { name: 'Bob', role: 'MEMBER' } });
};

// Script entry point for `prisma db seed`
if (import.meta.url === new URL(process.argv[1]!, 'file:').href) {
  const prisma = new PrismaClient();
  seed(prisma).then(() => prisma.$disconnect());
}
```

Pass this `seed` as the helpers' `seed` option and they seed once, then
snapshot so `resetDb()` restores it — no re-seed per test. Manually:

```typescript
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed';

let prisma: PrismaClient;
let resetDb: PGliteBridge['resetDb'];

beforeAll(async () => {
  const bridge = new PGliteBridge();
  await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
  prisma = new PrismaClient({ adapter: bridge.adapter });
  await seed(prisma);
  await bridge.snapshotDb();
  resetDb = bridge.resetDb;
});

beforeEach(() => resetDb()); // restores the snapshot — no re-seed needed
```

To re-seed every test (when seed data varies per spec), drop
`snapshotDb()` and re-invoke `seed(prisma)` inside `beforeEach` after
`resetDb()`.

## Other ORMs

`PgBridgePool` extends `pg.Pool`, so every ORM's standard Postgres
dialect runs on PGlite unchanged — and faster than the native PGlite
drivers: in the [ORM benchmark](../benchmark/BENCHMARK.md) the pool beats
every native driver on every operation (query builders 2.2–3.9× p50,
typeorm 1.7–2.5×, mikro-orm 1.4–1.9×), because PGlite's public `query()`
API makes ~6 separate WASM protocol crossings per call while the bridge
issues one buffered raw-stream write.

Import from `prisma-pglite-bridge/pool` — a subpath whose module graph
never loads any `@prisma/*` code (CI-enforced). "Prisma-free" is
import-graph-only: the package still installs its Prisma dependencies
(~5.6 MB, dominated by the schema engine) until 2.0; they are never
loaded at runtime through this entry. The root
`prisma-pglite-bridge` entry keeps requiring the Prisma peers.

### Wiring recipes

All verified by the benchmark harness (`benchmark/orm/`):

```typescript
import { PgBridgePool } from 'prisma-pglite-bridge/pool';

const pool = new PgBridgePool();

// drizzle
import { drizzle } from 'drizzle-orm/node-postgres';
const db = drizzle(pool);

// kysely
import { Kysely, PostgresDialect } from 'kysely';
const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });

// knex (CJS — default import only); knex >= 3.3.0's connectionPool
// hands it the pool without owning it: destroy() releases the reference.
import makeKnex from 'knex';
const db = makeKnex({ client: 'pg', connectionPool: pool });

// typeorm — inject the pool through the `driver` option's Pool shim
import { DataSource } from 'typeorm';
const ds = new DataSource({
  type: 'postgres',
  driver: { Pool: function PoolShim() { return pool; } },
  database: 'postgres',
  entities: [...],
});

// mikro-orm (v7, kysely-based) — hand the dialect as driverOptions
import { MikroORM } from '@mikro-orm/postgresql';
import { PostgresDialect } from 'kysely';
const orm = await MikroORM.init({
  entities: [...],
  dbName: 'postgres',
  driverOptions: new PostgresDialect({ pool }),
});
```

Caveats: mikro-orm v7 inlines parameters into the SQL text, so the
bridge's statement caching never engages there (its 1.4–1.9× win is pure
wire path); and the [unindexed-sort ceiling](./api.md#performance-notes)
applies to every driver equally.

### Testing with any ORM

`prisma-pglite-bridge/pool/vitest` (and `/pool/jest`) give non-Prisma
stacks the same testing lifecycle as the Prisma helpers — snapshot,
per-test reset, and the `test`/`file`/`worker` isolation scopes — with
your ORM's own migrator (or raw DDL) as the schema source:

```typescript
import { createPoolTest } from 'prisma-pglite-bridge/pool/vitest';
import { Kysely, PostgresDialect } from 'kysely';

const test = createPoolTest<Kysely<Database>>({
  setup: async ({ pool }) => {
    await pool.query('CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL)');
  },
  client: (pool) => new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
  seed: async (db) => {
    await db.insertInto('users').values({ name: 'Ada' }).execute();
  },
  dispose: (db) => db.destroy(),
});

test('starts from the seeded snapshot', async ({ client }) => {
  expect(await client.selectFrom('users').selectAll().execute()).toHaveLength(1);
});
```

`setupPGlitePool` is the one-call variant (hooks registered for you, like
`setupPGliteBridge`); async client factories (`await MikroORM.init(...)`)
are supported, and `dispose` runs your ORM's teardown (`destroy()` /
`close()`) before the pool shuts down. Release or return all checked-out
clients before `resetDb` — it throws `POOL_NOT_IDLE` while pool traffic
is in flight, same as the Prisma helpers.

## Local development and scripts

Beyond tests, the bridge (and `PGliteServer`) give you a Postgres for
local development without Docker.

### Persistent database

By default PGlite runs entirely in memory — the database disappears when
the process exits, which is ideal for tests. To keep data across restarts
(local development, prototyping), pass a `dataDir` when constructing
PGlite and hand it to the bridge; a caller-supplied PGlite is
caller-owned, so you control when it closes:

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const dataDir = './data/pglite';
const firstRun = !existsSync(join(dataDir, 'PG_VERSION'));

const pglite = new PGlite(dataDir);
const bridge = new PGliteBridge({ pglite }); // caller owns pglite
if (firstRun) await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });
```

**Add `data/pglite/` to `.gitignore`.** Delete the data directory after
schema changes to pick up new migrations. This is a local PostgreSQL
without Docker — handy for offline development or where installing
PostgreSQL is impractical.

### Dev server for Studio, psql, and the CLI

The in-process bridge is fine for a single Node app, but external tools
(`prisma studio`, `psql`, DBeaver, the `prisma` CLI itself) need a
wire-protocol endpoint. `PGliteServer` provides one; combine it with a
persistent `dataDir` for a long-running local Postgres. See
[`PGliteServer`](./server.md) for options, the connection URL, and
security notes. A two-server setup (main + a shadow for `migrate dev`)
looks like:

```typescript
// scripts/db-dev.ts
import { PGlite } from '@electric-sql/pglite';
import { PGliteServer, hasMigrations, pushMigrations } from 'prisma-pglite-bridge';

// Caller-supplied PGlite because we need a persistent dataDir:
const mainPglite = new PGlite('./data/pglite');
const shadowPglite = new PGlite('./data/shadow');

const server = new PGliteServer({ pglite: mainPglite, port: 54321 });
const shadow = new PGliteServer({ pglite: shadowPglite, port: 54322 });

if (!(await hasMigrations(server.pglite))) {
  await pushMigrations(server.pglite, { migrationsPath: './prisma/migrations' });
}

const [DATABASE_URL, SHADOW_DATABASE_URL] = await Promise.all([server.listen(), shadow.listen()]);

console.log(`DATABASE_URL=${DATABASE_URL}`);
console.log(`SHADOW_DATABASE_URL=${SHADOW_DATABASE_URL}`);

const shutdown = async () => {
  await server.close();
  await shadow.close();
  // pglite instances are caller-owned — close them too
  await mainPglite.close();
  await shadowPglite.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

Point `prisma.config.ts` at the shadow via `SHADOW_DATABASE_URL`:

```typescript
// prisma.config.ts
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
```

Run the server in one terminal (`tsx scripts/db-dev.ts`, exporting the
two printed URLs into your environment), then in another:

```sh
pnpm prisma migrate dev   # uses the shadow DB
pnpm prisma studio        # connects to DATABASE_URL
psql "$DATABASE_URL"      # ad-hoc inspection
```

Add `data/` to `.gitignore`. Delete the directory to start fresh or to
pick up new migrations (`hasMigrations` returns `true` once any migration
has been applied, so subsequent runs skip `pushMigrations`).

### Long-running script with clean shutdown

```typescript
import { PrismaClient } from '@prisma/client';
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge();
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });

try {
  await seedDatabase(prisma); // your seed function
} finally {
  await prisma.$disconnect();
  await bridge.close(); // closes pool + internally-created PGlite
}
```
