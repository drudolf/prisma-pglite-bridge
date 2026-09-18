# Cookbook

End-to-end examples for common test setups and dev workflows.
For the underlying API, see the [API reference](./api.md).

## Contents

- [Testing](#testing)
  - [Vitest: one call or fixtures](#vitest-one-call-or-fixtures)
  - [Jest: one call](#jest-one-call)
  - [Other runners and cross-process templates](#other-runners-and-cross-process-templates)
  - [Choosing an isolation model](#choosing-an-isolation-model)
  - [Wiring the bridge into your app](#wiring-the-bridge-into-your-app)
  - [Schema and seed](#schema-and-seed)
  - [Raw SQL next to Prisma](#raw-sql-next-to-prisma)
  - [On-failure query trail](#on-failure-query-trail)
  - [End-to-end: run your app against the bridge](#end-to-end-run-your-app-against-the-bridge)
  - [Running in CI](#running-in-ci)
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
[API reference](./api.md#the-vitest-and-jest-entries-prisma-testing-helpers).

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

### Other runners and cross-process templates

`prisma-pglite-bridge/testing` is the hook-free core under the vitest
and Jest helpers, for runners without a fixture layer — node:test, ava,
a vitest `globalSetup` — and for reusing one seeded database across
processes. `createBridgeContext` is `setupPGliteBridge` without the
hooks; `createBridgeTemplate` dumps a migrated + seeded data directory
once, and `loadBridgeTemplate` boots a fresh, independent PGlite from it
per test in a fraction of the cold-start cost (the mechanism behind
`scope: 'test'`). Every context has a `close()` that ends the pool and
closes the PGlite the context created; it never calls
`prisma.$disconnect()`, so add that yourself if your runner waits on
open handles. Surface: [API
reference](./api.md#the-testing-and-pooltesting-entries-runner-agnostic-builders).

**node:test.** Build the template once per file, load it per test:

```typescript
// tests/users.test.ts — run with `node --test` (tsx or --experimental-strip-types)
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import type { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import {
  type BridgeTemplate,
  createBridgeTemplate,
  loadBridgeTemplate,
} from 'prisma-pglite-bridge/testing';

const client = (adapter: PrismaPg) => new PrismaClient({ adapter });
let template: BridgeTemplate;

before(async () => {
  template = await createBridgeTemplate({
    client,
    migrations: true,
    seed: async (prisma) => {
      await prisma.user.create({ data: { email: 'ada@example.com', name: 'Ada' } });
    },
  });
});

test('starts from the seeded template', async () => {
  const { prisma, close } = await loadBridgeTemplate(template, { client });
  try {
    assert.equal(await prisma.user.count(), 1);
  } finally {
    await close();
  }
});
```

A template is a `Blob`; nothing to tear down after the file. Prefer one
shared database per file with a reset between tests? Use the context
builder and the runner's hooks:

```typescript
import { after, beforeEach } from 'node:test';
import { createBridgeContext } from 'prisma-pglite-bridge/testing';

const ctx = await createBridgeContext({ client, migrations: true, seed });
beforeEach(() => ctx.bridge.resetDb()); // back to the seeded snapshot
after(() => ctx.close());
```

**vitest `globalSetup` → file → per-worker load.** Build the template
once in the main process, write it to disk, and let every worker load
it. A dump is a raw PGlite data directory — locked to the PGlite version
that wrote it, the migrations, and the seed, and the bridge validates
none of that — so the cache filename carries all three:

```typescript
// tests/global-setup.ts — vitest.config: test.globalSetup = ['./tests/global-setup.ts']
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { createBridgeTemplate } from 'prisma-pglite-bridge/testing';
import type { TestProject } from 'vitest/node';
import { seed } from './seed.js';

const require = createRequire(import.meta.url);
const migrationsPath = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

const pgliteVersion = (): string => {
  let dir = dirname(require.resolve('@electric-sql/pglite'));
  while (!existsSync(join(dir, 'package.json'))) dir = dirname(dir);
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
};

const templateKey = (): string => {
  const hash = createHash('sha256').update(pgliteVersion());
  const files = readdirSync(migrationsPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  for (const file of files) {
    hash.update(relative(migrationsPath, file)).update(readFileSync(file));
  }
  hash.update(readFileSync(new URL('./seed.ts', import.meta.url)));
  return hash.digest('hex').slice(0, 16);
};

export default async ({ provide }: TestProject) => {
  const path = join('node_modules/.cache/pglite-templates', `${templateKey()}.tar.gz`);
  if (!existsSync(path)) {
    const template = await createBridgeTemplate({
      client: (adapter) => new PrismaClient({ adapter }),
      migrations: { migrationsPath },
      seed,
      compression: 'gzip',
    });
    mkdirSync(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(await template.arrayBuffer()));
  }
  provide('templatePath', path);
};

declare module 'vitest' {
  export interface ProvidedContext {
    templatePath: string;
  }
}
```

```typescript
// tests/users.test.ts — any worker, any pool
import { openAsBlob } from 'node:fs';
import type { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { loadBridgeTemplate } from 'prisma-pglite-bridge/testing';
import { expect, inject, test } from 'vitest';

const client = (adapter: PrismaPg) => new PrismaClient({ adapter });

test('starts from the cached template', async () => {
  const blob = await openAsBlob(inject('templatePath'));
  const { prisma, close } = await loadBridgeTemplate(blob, { client, compression: 'gzip' });
  try {
    expect(await prisma.user.count()).toBe(1);
  } finally {
    await close();
  }
});
```

`compression` must match on both ends (`'none'`, the default, for
in-process reuse; `'gzip'` for a file). The loader sets the MIME type
PGlite keys its gunzip decision on, so the `openAsBlob` result needs no
`type`. A mismatch, a dump from another PGlite version, or a file that
is not a data directory fails as `TEMPLATE_LOAD_FAILED` with PGlite's
error in `cause`. A loaded context holds no snapshot — `resetDb()`
truncates it to empty — so load the template again when a test needs the
seed back rather than resetting.

**On-failure query trail without the fixture helper.** Turn the trail on
through the bridge options and print it where your runner reports the
failure:

```typescript
import { formatQueryTrail } from 'prisma-pglite-bridge';

const ctx = await loadBridgeTemplate(template, { client, bridge: { queryTrail: true } });
// in the failure path of the test:
console.error(formatQueryTrail(ctx.bridge.queryTrail(), ctx.bridge.queryTrailMeta(), { testName }));
```

The pool twin for non-Prisma stacks is `prisma-pglite-bridge/pool/testing`:
`createPoolContext`, `createPoolTemplate`, and `loadPoolTemplate` over
the `setupPGlitePool` options (`setup`, `client`, `seed`, `dispose`),
with the same `compression`, ownership, and reset-to-empty rules.

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

**Transaction rollback per test is not offered.** The classic "open a
transaction in `beforeEach`, roll it back in `afterEach`" pattern is not
on the dial, by design. Prisma opens its own transactions for nested
writes and `$transaction`, and Postgres has no nested transactions — a
rollback-per-test wrapper would have to intercept every `BEGIN` and turn
it into a savepoint, which changes the semantics under test (isolation
level, `COMMIT`-time constraint checks, `LISTEN`/`NOTIFY`, and anything
the app does on a second connection). The snapshot model keeps the real
transaction behavior and is cheap because PGlite is in-process: the
reset is a truncate plus a restore from the in-memory snapshot, tens of
milliseconds on the reference machines (see [CI](#running-in-ci) for the
measured figures). It is the right trade whenever the code under test
uses transactions itself; if it never does and the suite is dominated by
thousands of tiny tests, `scope: 'file'` still applies and the reset
cost is the price of fidelity.

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

### Raw SQL next to Prisma

Two ways to run SQL Prisma will not express, with different rules:

- **`bridge.pglite.query(...)` / `bridge.pglite.exec(...)`** — straight
  into PGlite, bypassing the pool and its session lock. Cheapest, but
  the lock cannot see it: run it only while the pool is idle — no
  query in flight, no client checked out, never inside a Prisma
  `$transaction` — or it lands in the middle of Prisma's statements on
  the one session. Right for setup and for assertions between
  `await`ed Prisma calls (`seed` runs in exactly that state).
- **A second `PgBridgePool({ pglite: bridge.pglite })`** — a real
  `pg.Pool` over the same instance, for use alongside Prisma and with
  `pg` tooling (`COPY`, cursors, `LISTEN`). PGlite executes one
  statement at a time, and each pool's own session lock keeps its own
  transactions intact, so plain queries from both sides are safe to
  overlap. What the locks do not cover is each other: a transaction on
  this pool and a Prisma transaction can interleave on the one session,
  so await one side's transaction before starting the other's. Session
  state is shared the same way: a `SET`, temp table, or advisory lock
  taken through one pool is visible to, and held against, the other.
  Constructing the pool emits `PGliteBridgeSharedInstanceWarning`, the
  advisory saying exactly that. Statement caches are per client, so
  pools over one PGlite cache safely side by side. `end()` it before
  `bridge.close()`, and keep it idle across `resetDb()`.

There is no `bridge.pool` accessor: the pool under the adapter is
Prisma's, and reaching into it mid-flight would break the idle
guarantee `resetDb()` relies on.

```typescript
import { PgBridgePool } from 'prisma-pglite-bridge/pool';

const { bridge, prisma } = await setupPGliteBridge({ /* ... */ });

// Between Prisma calls, pool idle: direct.
await bridge.pglite.exec('ALTER TABLE "User" ADD COLUMN nickname text');
const { rows } = await bridge.pglite.query<{ n: number }>(
  'SELECT count(*)::int AS n FROM "User"',
);

// Alongside Prisma, or with pg tooling: a second pool, closed before the bridge.
const raw = new PgBridgePool({ pglite: bridge.pglite });
await raw.query('INSERT INTO "User" (email, name) VALUES ($1, $2)', ['grace@example.com', 'Grace']);
await raw.end();
```

### On-failure query trail

The `vitest` and `pool/vitest` fixture helpers capture the SQL each test
runs and, when a test fails, print the failing test's trail to stderr —
on by default, scoped to that test, with no configuration. It answers the
question an assertion diff leaves open: *what did the test actually do to
the database?*

**The failure walkthrough.** Given a test that inserts a row whose email
collides with the seeded one:

```text
pglite-bridge query trail — 3 queries — test "creates a user with a unique email"
#0 c0 0.28ms BEGIN · BEGIN
#1 c0 0.67ms QUERY · INSERT INTO users (email, name) VALUES ($1, $2) · [grace@example.com, Grace]
#2 c0 1.58ms QUERY · INSERT INTO users (email, name) VALUES ($1, $2) · [ada@example.com, Ada II]
    ↳ error 23505: duplicate key value violates unique constraint "users_email_key"
```

Each entry is `#<seq> c<clientId> <duration> <KIND> · <sql> · [params]`:
the sequence number orders submissions across all pool clients, `c0` is
the client ordinal, the kind labels transaction boundaries (`BEGIN`,
`COMMIT`, `SAVEPOINT`, `ROLLBACK`, …) as flat entries and everything else
as `QUERY`, and a failed query carries its error — code and message —
on the following `↳` line. A query still in flight when the failure hook
fires renders `pending` instead of a duration. There is no `COMMIT` line
above because the second `INSERT` threw first; the pool then rolled the
open transaction back — the trail shows exactly the statements that ran,
in order.

**Jest and standalone (accessor path).** The failure printout is a
vitest feature (it hooks `onTestFailed`), but the capture is not. Enable
`queryTrail` on the bridge or pool and read the structured entries
yourself — under Jest, in a `catch`, or anywhere you want them:

```typescript
import { PGliteBridge, formatQueryTrail } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge({ queryTrail: true });
// ... run the queries under test ...

// on failure (or wherever you want to inspect):
const entries = bridge.queryTrail();
const meta = bridge.queryTrailMeta();
console.error(formatQueryTrail(entries, meta, { testName: 'my failing case' }));
```

`PgBridgePool` exposes the same trio — `pool.queryTrail()`,
`pool.queryTrailMeta()`, `pool.clearQueryTrail()` — for non-Prisma
stacks. `clearQueryTrail()` resets the trail between cases; the fixture
helpers call it for you at the start of each test.

**JSONL for agents.** Set `PGLITE_BRIDGE_TRAIL_FORMAT=json` and the
failure printout switches to JSONL: the first line is a `trail-header`
event (`formatVersion`, `testName`, `droppedCount`, `disabled`), then one
JSON object per entry — machine-readable without parsing prose. The same
shape comes out of `formatQueryTrail(entries, meta, { format: 'json' })`.

**Redaction for CI.** Params are previews of your fixture data, printed to
the same console your assertion failures already use — but CI logs are
durable and widely shared. Pass `queryTrail: { redactParams: true }` (on
the pool/bridge option, or via the helper's `queryTrail` when you build
your own effective options) to render every param as `<redacted>`; the
SQL and errors still print.

**The kill switch.** `PGLITE_BRIDGE_QUERY_TRAIL=0` disables both capture
and printing suite-wide, regardless of any option. It can only ever
disable — it never forces capture on.

**Deliberately excluded.** The trail shows what *your* code did, so the
bridge's own internal recovery statements (the duplex teardown
`ROLLBACK`s) never appear, and per-test reset/seed traffic is cleared
before each test so a failure prints only that test's own queries.

Want more than a trail — "give me the database state at step k" for
replay or bisection? That is a deliberate non-goal for now, gated on
measured demand: open an issue on the
[issue tracker](https://github.com/drudolf/prisma-pglite-bridge/issues)
and say so.

### End-to-end: run your app against the bridge

The in-process bridge lives in the test process, so a server you spawn
separately (a built HTTP server, a Next.js dev server, a CLI, the app
Playwright drives) cannot reach it. For those, serve the same PGlite
over a socket with [`PGliteServer`](./server.md) and hand the child
process the URL as `DATABASE_URL` — the app's own `pg` / `PrismaPg`
stack connects to it like to any Postgres:

```typescript
// tests/app.e2e.test.ts
import { type ChildProcess, spawn } from 'node:child_process';
import { PGliteServer, pushMigrations } from 'prisma-pglite-bridge';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

const server = new PGliteServer(); // owns an in-memory PGlite
let app: ChildProcess;

beforeAll(async () => {
  const databaseUrl = await server.listen(); // postgres://postgres@127.0.0.1:<port>/postgres
  await pushMigrations(server.pglite, { migrationsPath: './prisma/migrations' });
  await server.pglite.exec(`INSERT INTO "User" (email, name) VALUES ('ada@example.com', 'Ada')`);
  await server.snapshotDb(); // resetDb() restores to this seeded state

  app = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, PORT: '3999' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise<void>((resolve, reject) => {
    let out = '';
    app.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('listening')) resolve();
    });
    app.once('exit', (code) => reject(new Error(`app exited early (${code}): ${out}`)));
  });
}, 30_000);

beforeEach(() => server.resetDb());

afterAll(async () => {
  if (app.exitCode === null) {
    const exited = new Promise((resolve) => app.once('exit', resolve));
    app.kill('SIGTERM');
    await exited;
  }
  await server.close(); // also closes the owned PGlite
});

test('POST /users then GET /users', async () => {
  const created = await fetch('http://127.0.0.1:3999/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'grace@example.com', name: 'Grace' }),
  });
  expect(created.status).toBe(201);

  const users = await (await fetch('http://127.0.0.1:3999/users')).json();
  expect(users).toHaveLength(2); // Ada from the seed + Grace
});
```

Order matters only at the start: `listen()` resolves once PGlite is
ready, and `pushMigrations` may run before or after it — it talks to
`server.pglite` directly and PGlite executes one statement at a time.
Spawn the app only after the schema is in place so its first query
does not race the DDL.

What this setup does and does not give you:

- **A server reset restores data, not connection state.** `SET`s,
  `LISTEN`s, temp tables, and advisory locks on the app's connections
  survive `server.resetDb()` — use a fresh connection (or restart the
  app) when a test depends on session state.
- **Seed and reset go through the server.** In `beforeAll`, after
  `pushMigrations`: seed via `server.pglite.exec(...)` — or build a
  `new PGliteBridge({ pglite: server.pglite })`, seed through a Prisma
  client on it, and close it *before* the next step — then
  `await server.snapshotDb()`. In `beforeEach` (or between tests),
  `await server.resetDb()`. Both wait for the app's running statement
  to finish and throw `SERVER_NOT_IDLE` when a connection is inside a
  transaction or still busy after `timeoutMs` (default 5000), so call
  them between requests, never during one. The server's lock covers
  only its own connections: anything else that reaches `server.pglite`
  — a direct `exec`, a companion bridge or pool — must be idle (or
  closed) when you call them. See
  [Snapshot and reset](./api.md#snapshot-and-reset).
- **One session.** PGlite is single-user: the app's connections and
  any `psql` you attach all serialize through the server's
  `SessionLock`. Parallel test workers hitting one server run one
  query at a time; give each worker its own `PGliteServer` + app pair
  (and its own port) if that becomes the bottleneck.
- **Playwright.** Start the server in
  [`globalSetup`](https://playwright.dev/docs/test-global-setup-teardown),
  apply the schema, and export the URL as `process.env.DATABASE_URL`
  before the `webServer` command starts; close the server in
  `globalTeardown`. The `webServer` entry inherits the environment, so
  the app boots against the bridge with no config change. The server
  object lives in the process that started it, so `server.resetDb()`
  has to run there: in `globalSetup`-owned code, or behind a test-only
  HTTP route served from that process which the specs hit between
  tests — spec files run in Playwright's worker processes and cannot
  reach the object directly.
- **No auth, loopback only.** The server accepts any user, no
  password, and rejects SSL — see [Security](./server.md#security).

### Running in CI

Nothing to provision: PGlite is a dependency, so the job is the plain
install-and-test job. A GitHub Actions job on the Node 24 action
runtime (every action pinned to a major that runs on it):

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm prisma generate
      - run: pnpm vitest run
        env:
          NODE_OPTIONS: --disable-warning=ExperimentalWarning
```

- **`--disable-warning=ExperimentalWarning`** silences Node's
  WASM-module warning, which `pushSchema` triggers once per worker
  (harmless — see [troubleshooting](./troubleshooting.md)).
  `pushMigrations` never triggers it.
- **The query trail lands in the job log.** A failing test prints the
  SQL it ran, parameters included. If test data holds anything you
  would not paste into that log, set `queryTrail: { redactParams: true }`
  on the helper, or `PGLITE_BRIDGE_QUERY_TRAIL=0` to turn the trail off
  — see [On-failure query trail](#on-failure-query-trail).
- **Workers and memory.** Each vitest worker holds its own PGlite: one
  WASM instance plus an in-memory data directory per live instance.
  Cold start is paid per file (`scope: 'file'`), once per worker
  (`'worker'`), or once per file with cheap per-test loads (`'test'`).
  Start with vitest's default worker count and cap `maxWorkers` only
  if the runner swaps; on a small shared runner, fewer workers with
  `scope: 'worker'` usually beats many workers each paying the cold
  start. Budget memory by measuring one worker on your runner —
  absolute RSS is not comparable across machines.

What the trade costs, from the reference run (`pnpm bench:isolation`,
n=20 per strategy after a warmup, macOS, bridge 1.7.0, PGlite 0.5.3
with a 0.5.4 re-run reproducing it, the repository's integration
schema and seed — two tenants and a few dozen rows; full conditions
and the memory tables in
[BENCHMARK.md](../benchmark/BENCHMARK.md#per-test-isolation-cost)):

| Strategy | `scope` | Apple M3 Max, Node 24.18.0 — p50 / p99 | Intel i9-9980HK MacBook Pro, Node 24.14.1 — p50 / p99 | One-time per file (M3 Max / i9) |
| --- | --- | --- | --- | --- |
| snapshot reset | `file` / `worker` | 12 ms / 23 ms | 42 ms / 48 ms | 0.64 s / 2.51 s |
| template load | `test` | 147 ms / 226 ms | 333 ms / 364 ms | 0.68 s / 1.86 s |
| cold start | per-test bridge (pre-1.6) | 634 ms / 803 ms | 1.88 s / 3.43 s | — |

Cold start is the most variance-prone strategy, so read the ratios as
the signal and the tails as indicative; each live instance in that run
kept an in-memory data directory of about 40 MB for that seed.

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
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite('./data/pglite');
const bridge = new PGliteBridge({ pglite }); // caller owns pglite
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });
```

`pushMigrations` keeps Prisma's `_prisma_migrations` history, so every
start applies only the migrations not yet recorded — no first-run
guard needed. **Add `data/pglite/` to `.gitignore`.** Delete the data
directory to start from an empty database. This is a local PostgreSQL
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
import { PGliteServer, pushMigrations } from 'prisma-pglite-bridge';

// Caller-supplied PGlite because we need a persistent dataDir:
const mainPglite = new PGlite('./data/pglite');
const shadowPglite = new PGlite('./data/shadow');

const server = new PGliteServer({ pglite: mainPglite, port: 54321 });
const shadow = new PGliteServer({ pglite: shadowPglite, port: 54322 });

await pushMigrations(server.pglite, { migrationsPath: './prisma/migrations' });

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

Add `data/` to `.gitignore`. `pushMigrations` needs no guard here: it
keeps Prisma's `_prisma_migrations` history, so subsequent starts skip
the migrations already applied and only apply new ones, and `prisma
migrate dev` against the server sees that history — no drift prompt,
no re-application. Delete the directory to start from an empty
database.

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
