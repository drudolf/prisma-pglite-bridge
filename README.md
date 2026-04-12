# prisma-enlite

In-process PGlite bridge for Prisma. Replaces the TCP socket in
`pg.Client` with a Duplex stream that speaks PostgreSQL wire protocol
directly to PGlite's WASM engine.

## Install

```sh
pnpm add -D prisma-enlite @electric-sql/pglite @prisma/adapter-pg pg
```

TypeScript users also need `@types/pg`.

## Quickstart

```typescript
import { createPgliteAdapter } from 'prisma-enlite';
import { PrismaClient } from '@prisma/client';

const { adapter, resetDb } = await createPgliteAdapter();
const prisma = new PrismaClient({ adapter });

// Per-test isolation (optional)
beforeEach(() => resetDb());
```

That's it. Schema is auto-discovered from `prisma.config.ts`
and migration files.

## Schema Resolution

`createPgliteAdapter()` resolves schema SQL in this order:

1. **`sql` option** — pre-generated SQL string, applied directly
2. **`migrationsPath` option** — reads migration files from the
   given directory
3. **Auto-discovered migrations** — uses `@prisma/config` to find
   migration files (same resolution as `prisma migrate dev`)

If no migration files are found, it throws with a message to run
`prisma migrate dev` first.

## API

### `createPgliteAdapter(options?)`

Creates a Prisma adapter backed by an in-process PGlite instance.

```typescript
const { adapter, resetDb, close } = await createPgliteAdapter({
  // All optional — migrations auto-discovered from prisma.config.ts
  migrationsPath: './prisma/migrations',
  sql: 'CREATE TABLE ...',
  dataDir: './data/pglite',  // omit for in-memory
  extensions: {},            // PGlite extensions
  max: 5,                    // pool connections (default: 5)
});
```

Returns:

- `adapter` — pass to `new PrismaClient({ adapter })`
- `resetDb()` — truncates all user tables, resets session state
  (`RESET ALL`, `DEALLOCATE ALL`). Call in `beforeEach` for
  per-test isolation.
- `close()` — shuts down pool and PGlite. Not needed in tests
  (process exit handles it). Use in long-running scripts or dev
  servers.

### `createPool(options?)`

Lower-level escape hatch. Creates a `pg.Pool` backed by PGlite
without Prisma wiring.

```typescript
import { createPool } from 'prisma-enlite';
import { PrismaPg } from '@prisma/adapter-pg';

const { pool, pglite, close } = await createPool();
const adapter = new PrismaPg(pool);
```

Accepts `dataDir`, `extensions`, `max`, and `pglite` (bring your
own pre-configured PGlite instance).

### `PGliteBridge`

The Duplex stream that replaces `pg.Client`'s TCP socket. Exported
for advanced use cases (custom `pg.Client` setup, direct wire
protocol access).

```typescript
import { PGliteBridge } from 'prisma-enlite';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const pglite = new PGlite();
await pglite.waitReady;
const client = new pg.Client({
  stream: () => new PGliteBridge(pglite),
});
```

## Examples

### Vitest with per-test isolation

```typescript
import { createPgliteAdapter } from 'prisma-enlite';
import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

let prisma: PrismaClient;
let resetDb: () => Promise<void>;

beforeAll(async () => {
  const { adapter, resetDb: reset } = await createPgliteAdapter();
  prisma = new PrismaClient({ adapter });
  resetDb = reset;
});

beforeEach(() => resetDb());

it('creates a user', async () => {
  const user = await prisma.user.create({ data: { name: 'Test' } });
  expect(user.id).toBeDefined();
});
```

### Pre-generated SQL (fastest)

```typescript
const { adapter } = await createPgliteAdapter({
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

### Long-running script with clean shutdown

```typescript
const { adapter, close } = await createPgliteAdapter();
const prisma = new PrismaClient({ adapter });

try {
  await seedDatabase(prisma);
} finally {
  await prisma.$disconnect();
  await close();
}
```

## Limitations

- **Node.js only** — requires `node:stream` and `node:fs`. Does
  not work in browsers despite PGlite's browser support.
- **WASM cold start** — first `createPgliteAdapter()` call takes
  ~2s for PGlite WASM compilation. Subsequent calls in the same
  process reuse the compiled module.
- **Single PostgreSQL session** — PGlite runs in single-user mode.
  All pool connections share one session. A `SessionLock` serializes
  transactions (one at a time), but `SET` variables leak between
  connections within a single test. `resetDb()` clears this between
  tests via `RESET ALL` and `DEALLOCATE ALL`.
- **PGlite extensions** — if your schema uses `pgcrypto`,
  `uuid-ossp`, etc., pass them via the `extensions` option. See
  PGlite docs for available extensions.
- **Migration files required** — run `prisma migrate dev` once to
  generate migration files, or pass schema SQL directly via the
  `sql` option.

## License

MIT
