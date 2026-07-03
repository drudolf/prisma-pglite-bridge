# Cookbook

End-to-end examples for common test setups and dev workflows.
For the underlying API, see the [API reference](./api.md).

## Contents

- [Vitest one-call setup](#vitest-one-call-setup)
- [Test-context fixtures (`createBridgeTest`)](#test-context-fixtures-createbridgetest)
- [Multi-file tests with a shared bridge](#multi-file-tests-with-a-shared-bridge)
- [Per-file bridge (no production singleton)](#per-file-bridge-no-production-singleton)
- [Sharing seed logic between `prisma db seed` and tests](#sharing-seed-logic-between-prisma-db-seed-and-tests)
- [Applying a schema directly (no migrations directory)](#applying-a-schema-directly-no-migrations-directory)
- [Using PostgreSQL extensions](#using-postgresql-extensions)
- [Pre-generated SQL (fastest)](#pre-generated-sql-fastest)
- [Persistent dev database (optional)](#persistent-dev-database-optional)
- [Long-lived dev server (Studio, `psql`, `prisma migrate dev`)](#long-lived-dev-server-studio-psql-prisma-migrate-dev)
- [Long-running script with clean shutdown](#long-running-script-with-clean-shutdown)

## Vitest one-call setup

For Vitest, `setupPGliteBridge` from the `prisma-pglite-bridge/vitest`
entry point collapses the whole flow — bridge, migrations, seed,
snapshot, and lifecycle hooks — into one call:

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

### Test-context fixtures (`createBridgeTest`)

The fixture variant wraps the same flow in vitest's
[test context](https://vitest.dev/guide/test-context.html) — tests
declare what they need, typed, and vitest sequences setup and
teardown:

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

Every test taking `prisma` starts from the seeded snapshot (the
fixture resets before handing it over); tests taking only `bridge`
skip the reset; tests taking neither skip the database entirely.
Compose your own fixtures on top with `test.extend`. Requires
vitest ≥ 3.2 (fixture scopes).

### Isolation model

**The test file is the database boundary.** Each `setupPGliteBridge`
or `createBridgeTest` call creates its own bridge and its own
in-memory PGlite — so with Vitest's default `isolate: true`, every
test file gets a private database and files cannot interfere with
each other. Within a file, tests share that one instance and are
isolated by the snapshot reset between tests.

The trade-off dial:

- **One bridge per file (both APIs' default)** — maximum isolation;
  each file pays the cold start (WASM init + migrations + seed,
  roughly 0.5–2s depending on hardware).
- **`createBridgeTest({ scope: 'worker', ... })`** — one warm bridge
  shared across all files a worker runs, with default isolation left
  ON: the cold start, migrations, and seed are paid once per worker,
  and the per-test snapshot reset still applies. All files in the
  worker share one seeded snapshot, so this fits projects with one
  global fixture set. (Uses vitest worker-scoped fixtures; on the
  `vmThreads`/`vmForks` pools these initialize per file, so the
  amortization applies to the default `threads`/`forks` pools.)
- **`createBridgeTest({ scope: 'test', ... })`** — a fresh bridge per
  test: the full cold start on every test, in exchange for total
  isolation. This is the one configuration where `test.concurrent`
  is safe — each concurrent test owns its own PGlite session.
- **`setupPGliteBridge` in a `setupFiles` entry with
  `isolate: false`** — the pre-fixture equivalent of worker scope;
  still works, but `scope: 'worker'` achieves the same without
  giving up isolation. This mirrors the [shared-bridge
  pattern](#multi-file-tests-with-a-shared-bridge) below.

**Don't use `test.concurrent` with a shared context**: concurrent
tests would interleave on one single-session PGlite, and `resetDb`
deliberately throws while pool clients are checked out. The
exception is `createBridgeTest({ scope: 'test' })`, which gives
every test its own instance.

The sections below use the explicit building blocks, which the
helper wraps; reach for them with other test runners or when you
need custom wiring like `vi.mock`.

## Multi-file tests with a shared bridge

The recommended pattern for a multi-file Vitest suite. The bridge
is created once and `vi.mock` rewires every test file's
`PrismaClient` import to it — migrations and seed run a single
time, all tests share one snapshot, and `resetDb()` runs before
every test. Skip to the
[per-file bridge pattern](#per-file-bridge-no-production-singleton)
if your code receives `PrismaClient` as a parameter and you don't
have a production singleton to swap.

Most Prisma projects use a singleton module:

```typescript
// lib/prisma.ts — your production singleton
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
export const prisma = new PrismaClient({ adapter });
```

In tests, swap the singleton via `vi.mock` so every import gets
the in-memory PGlite version:

```typescript
// vitest.setup.ts
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeEach, vi } from 'vitest';

const bridge = new PGliteBridge();
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
export const testPrisma = new PrismaClient({ adapter: bridge.adapter });

vi.mock('./lib/prisma', () => ({ prisma: testPrisma }));

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

Now every test file that imports `prisma` from `lib/prisma`
gets the PGlite-backed instance. No Docker, no test database,
no cleanup scripts.

For Jest, the same pattern works with `jest.mock`. Note that
`jest.mock` is hoisted to the top of the file — place it at
the top level, not inside `beforeAll`:

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

## Per-file bridge (no production singleton)

Each test file owns its own bridge — appropriate when your code
accepts `PrismaClient` as a parameter (no production singleton to
mock). For suites with many test files, this re-runs migrations
and seed in every file's `beforeAll`; prefer the
[shared bridge pattern](#multi-file-tests-with-a-shared-bridge)
once that cost matters.

If your code accepts `PrismaClient` as a parameter:

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
  const user = await prisma.user.create({
    data: { name: 'Test' },
  });
  expect(user.id).toBeDefined();
});
```

## Sharing seed logic between `prisma db seed` and tests

Extract your seed logic into a function that accepts a
PrismaClient:

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

Then reuse it in tests:

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

// resetDb() restores the snapshot — no re-seed needed.
beforeEach(() => resetDb());
```

If you'd rather re-seed every test (for example, when seed data
varies per spec), drop the `snapshotDb()` call and re-invoke
`seed(prisma)` inside `beforeEach` after `resetDb()`.

## Applying a schema directly (no migrations directory)

For test fixtures or prototypes without `prisma/migrations`, swap
`pushMigrations` for `pushSchema`:

```typescript
import { readFile } from 'node:fs/promises';
import { PGliteBridge, pushSchema } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge();
await pushSchema(bridge.adapter, {
  schema: await readFile('prisma/schema.prisma', 'utf8'),
});
```

## Using PostgreSQL extensions

If your schema uses `uuid-ossp`, `pgcrypto`, or other extensions,
construct PGlite with the `extensions` option and pass it to the
bridge — the bridge treats it as caller-owned:

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

Extensions are included in the `@electric-sql/pglite` package —
no extra install needed. See [PGlite extensions](https://pglite.dev/extensions/)
for the full list.

## Pre-generated SQL (fastest)

The `sql` option on `pushMigrations` runs verbatim with no sandbox
or checksum. Compose it from trusted, version-controlled source
only — never from environment variables, network input, or values
that cross a trust boundary.

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

## Persistent dev database (optional)

By default, PGlite runs entirely in memory — the database
disappears when the process exits. This is ideal for tests. If you
want data to survive restarts (local development, prototyping),
pass a `dataDir` when constructing PGlite and supply it to the
bridge — the bridge treats a caller-supplied PGlite as caller-owned,
so you control when it closes:

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const dataDir = './data/pglite';
const firstRun = !existsSync(join(dataDir, 'PG_VERSION'));

const pglite = new PGlite(dataDir);
const bridge = new PGliteBridge({ pglite }); // caller owns pglite
if (firstRun) await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });
```

**Add `data/pglite/` to `.gitignore`.** Delete the data directory
after schema changes to pick up new migrations. This gives you a
local PostgreSQL without Docker — useful for offline development
or environments where installing PostgreSQL is impractical.

## Long-lived dev server (Studio, `psql`, `prisma migrate dev`)

The persistent recipe above runs PGlite in-process — fine for a
single Node app, but external tools (`prisma studio`, `psql`,
DBeaver, the `prisma` CLI itself) need a wire-protocol endpoint.
Combine `PGliteServer` with a persistent `dataDir` to get a
long-running local Postgres without Docker:

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

Wire it up:

```json
// package.json
{
  "scripts": {
    "db:dev": "tsx scripts/db-dev.ts"
  }
}
```

```sh
# .env
DATABASE_URL=postgres://postgres@127.0.0.1:54321/postgres
SHADOW_DATABASE_URL=postgres://postgres@127.0.0.1:54322/postgres
```

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

Run `pnpm db:dev` in one terminal, then in another:

```sh
pnpm prisma migrate dev   # uses the shadow DB
pnpm prisma studio        # connects to DATABASE_URL
psql "$DATABASE_URL"      # ad-hoc inspection
```

Add `data/` to `.gitignore`. Delete the directory to start fresh
or to pick up new migrations (`hasMigrations` returns `true` once
any migration has been applied, so subsequent runs skip
`pushMigrations`).

## Long-running script with clean shutdown

```typescript
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge();
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });

try {
  await seedDatabase(prisma);
} finally {
  await prisma.$disconnect();
  await bridge.close(); // closes pool + internally-created PGlite
}
```
