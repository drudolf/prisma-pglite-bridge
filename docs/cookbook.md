# Cookbook

End-to-end examples for common test setups and dev workflows.
For the underlying API, see the [API reference](./api.md).

## Contents

- [Replacing your production database in tests](#replacing-your-production-database-in-tests)
- [Vitest with per-test isolation (no singleton)](#vitest-with-per-test-isolation-no-singleton)
- [Sharing seed logic between `prisma db seed` and tests](#sharing-seed-logic-between-prisma-db-seed-and-tests)
- [Applying a schema directly (no migrations directory)](#applying-a-schema-directly-no-migrations-directory)
- [Using PostgreSQL extensions](#using-postgresql-extensions)
- [Pre-generated SQL (fastest)](#pre-generated-sql-fastest)
- [Persistent dev database (optional)](#persistent-dev-database-optional)
- [Long-running script with clean shutdown](#long-running-script-with-clean-shutdown)

## Replacing your production database in tests

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
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeEach, vi } from 'vitest';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
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
const { PGlite } = require('@electric-sql/pglite');
const { createPGliteBridge, pushMigrations } = require('prisma-pglite-bridge');
const { PrismaClient } = require('@prisma/client');

let testPrisma;
let resetDb;

jest.mock('./lib/prisma', () => ({
  get prisma() { return testPrisma; },
}));

beforeAll(async () => {
  const pglite = new PGlite();
  const bridge = await createPGliteBridge({ pglite });
  await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
  testPrisma = new PrismaClient({ adapter: bridge.adapter });
  resetDb = bridge.resetDb;
});

beforeEach(() => resetDb());
```

## Vitest with per-test isolation (no singleton)

If your code accepts `PrismaClient` as a parameter:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations, type ResetDbFn } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, it, expect } from 'vitest';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  const pglite = new PGlite();
  const bridge = await createPGliteBridge({ pglite });
  await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
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
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations, type ResetDbFn } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  const pglite = new PGlite();
  const bridge = await createPGliteBridge({ pglite });
  await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
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
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushSchema } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushSchema(bridge.adapter, {
  schema: await readFile('prisma/schema.prisma', 'utf8'),
});
```

## Using PostgreSQL extensions

If your schema uses `uuid-ossp`, `pgcrypto`, or other extensions,
pass them via the `extensions` option:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const pglite = new PGlite({ extensions: { uuid_ossp, pgcrypto } });
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
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
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(pglite, {
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
pass a `dataDir` when constructing PGlite, and only apply
migrations on first run:

```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const dataDir = './data/pglite';
const firstRun = !existsSync(join(dataDir, 'PG_VERSION'));

const pglite = new PGlite(dataDir);
const bridge = await createPGliteBridge({ pglite });
if (firstRun) await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });
```

**Add `data/pglite/` to `.gitignore`.** Delete the data directory
after schema changes to pick up new migrations. This gives you a
local PostgreSQL without Docker — useful for offline development
or environments where installing PostgreSQL is impractical.

## Long-running script with clean shutdown

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });

try {
  await seedDatabase(prisma);
} finally {
  await prisma.$disconnect();
  await bridge.close();
  await pglite.close();
}
```
