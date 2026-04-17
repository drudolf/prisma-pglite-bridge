# prisma-pglite-bridge

In-process PGlite bridge for Prisma. Replaces the TCP socket in
`pg.Client` with a Duplex stream that speaks PostgreSQL wire protocol
directly to PGlite's WASM engine.

## Install

Requires **Prisma 7+** and **Node.js 20+**.

```sh
pnpm add -D prisma-pglite-bridge @electric-sql/pglite @prisma/adapter-pg pg
```

The last three are peer dependencies you may already have.
TypeScript users also need `@types/pg`.

## Quickstart

```typescript
import { createPgliteAdapter } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';

const { adapter, resetDb } = await createPgliteAdapter();
const prisma = new PrismaClient({ adapter });

// Per-test isolation (optional)
beforeEach(() => resetDb());
```

That's it. Schema is auto-discovered from `prisma.config.ts`
and migration files (run `prisma migrate dev` first if you
haven't already). No Docker, no database server — works
in GitHub Actions, GitLab CI, and any environment where
Node.js runs.

## Schema Resolution

`createPgliteAdapter()` resolves schema SQL in this order:

1. **`sql` option** — pre-generated SQL string, applied directly
2. **`migrationsPath` option** — reads migration files from the
   given directory
3. **Auto-discovered migrations** — uses `@prisma/config` to find
   migration files (same resolution as `prisma migrate dev`).
   Requires `prisma` to be installed (which provides
   `@prisma/config` as a transitive dependency).

If no migration files are found, it throws with a message to run
`prisma migrate dev` first.

## API

### `createPgliteAdapter(options?)`

Creates a Prisma adapter backed by an in-process PGlite instance.

```typescript
const { adapter, pglite, resetDb, close, stats } = await createPgliteAdapter({
  // All optional — migrations auto-discovered from prisma.config.ts
  migrationsPath: './prisma/migrations', // or:
  sql: 'CREATE TABLE ...',              // (first match wins, see Schema Resolution)
  configRoot: '../..',        // monorepo: where to find prisma.config.ts
  dataDir: './data/pglite',   // omit for in-memory
  extensions: {},             // PGlite extensions
  max: 5,                     // pool connections (default: 5)
  statsLevel: 0,              // telemetry level (default: 0 = off)
});
```

Returns:

- `adapter` — pass to `new PrismaClient({ adapter })`
- `pglite` — the underlying PGlite instance for direct SQL,
  snapshots, or extension access
- `resetDb()` — truncates all user tables, resets session state
  (`RESET ALL`, `DEALLOCATE ALL`). Call in `beforeEach` for
  per-test isolation. Note: this clears all data including seed
  data — re-seed after reset if needed.
- `close()` — shuts down pool and PGlite. Not needed in tests
  (process exit handles it). Use in long-running scripts or dev
  servers.
- `stats()` — returns telemetry when `statsLevel > 0`, else `null`.
  See [Stats collection](#stats-collection).

### `createPool(options?)`

Lower-level escape hatch. Creates a `pg.Pool` backed by PGlite
without automatic schema resolution — useful for custom Prisma
setups, other ORMs, or raw SQL.

```typescript
import { createPool } from 'prisma-pglite-bridge';
import { PrismaPg } from '@prisma/adapter-pg';

const { pool, pglite, close } = await createPool();
const adapter = new PrismaPg(pool);
```

Returns `pool` (pg.Pool), `pglite` (the underlying PGlite
instance), and `close()`. Accepts `dataDir`, `extensions`, `max`,
and `pglite` (bring your own pre-configured PGlite instance).

### `PGliteBridge`

The Duplex stream that replaces `pg.Client`'s network socket.
Exported for advanced use cases (custom `pg.Client` setup, direct
wire protocol access). When using multiple bridges against the
same PGlite instance, pass a shared `SessionLock` to prevent
transaction interleaving.

```typescript
import { PGliteBridge, SessionLock } from 'prisma-pglite-bridge';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const pglite = new PGlite();
await pglite.waitReady;

const lock = new SessionLock();
const client = new pg.Client({
  stream: () => new PGliteBridge(pglite, lock),
});
```

## Examples

### Replacing your production database in tests

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
import { createPgliteAdapter } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';

const { adapter, resetDb } = await createPgliteAdapter();
export const testPrisma = new PrismaClient({ adapter });

vi.mock('./lib/prisma', () => ({ prisma: testPrisma }));

beforeEach(() => resetDb());
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
const { createPgliteAdapter } = require('prisma-pglite-bridge');
const { PrismaClient } = require('@prisma/client');

let testPrisma;
let resetDb;

jest.mock('./lib/prisma', () => ({
  get prisma() { return testPrisma; },
}));

beforeAll(async () => {
  const result = await createPgliteAdapter();
  testPrisma = new PrismaClient({ adapter: result.adapter });
  resetDb = result.resetDb;
});

beforeEach(() => resetDb());
```

### Vitest with per-test isolation (no singleton)

If your code accepts `PrismaClient` as a parameter:

```typescript
import { createPgliteAdapter, type ResetDbFn } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, it, expect } from 'vitest';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  const result = await createPgliteAdapter();
  prisma = new PrismaClient({ adapter: result.adapter });
  resetDb = result.resetDb;
});

beforeEach(() => resetDb());

it('creates a user', async () => {
  const user = await prisma.user.create({
    data: { name: 'Test' },
  });
  expect(user.id).toBeDefined();
});
```

### Sharing seed logic between `prisma db seed` and tests

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
import { createPgliteAdapter, type ResetDbFn } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  const result = await createPgliteAdapter();
  prisma = new PrismaClient({ adapter: result.adapter });
  resetDb = result.resetDb;
  await seed(prisma);
});

// resetDb() clears all data — re-seed if needed
beforeEach(async () => {
  await resetDb();
  await seed(prisma);
});
```

### Using PostgreSQL extensions

If your schema uses `uuid-ossp`, `pgcrypto`, or other extensions,
pass them via the `extensions` option:

```typescript
import { createPgliteAdapter } from 'prisma-pglite-bridge';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const { adapter } = await createPgliteAdapter({
  extensions: { uuid_ossp, pgcrypto },
});
```

Extensions are included in the `@electric-sql/pglite` package —
no extra install needed. See [PGlite extensions](https://pglite.dev/extensions/)
for the full list.

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

### Persistent dev database (optional)

By default, prisma-pglite-bridge runs entirely in memory — the database
disappears when the process exits. This is ideal for tests. If you
want data to survive restarts (local development, prototyping),
pass a `dataDir`:

```typescript
const { adapter, close } = await createPgliteAdapter({
  dataDir: './data/pglite',
});
const prisma = new PrismaClient({ adapter });

// Data persists across restarts. Schema is only applied on first run
// (PGlite detects an existing PGDATA directory). Delete the data
// directory after schema changes to pick up new migrations.
```

**Add `data/pglite/` to `.gitignore`.** This gives you a local
PostgreSQL without Docker — useful for offline development or
environments where installing PostgreSQL is impractical.

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

## Stats collection

Opt-in telemetry about what happened during a test run — query counts,
timing percentiles, database size, and (at level 2) process RSS and
session-lock wait times. Useful for CI cost insight, perf tuning, and
understanding test-suite behavior. **Off by default** (zero overhead
on the hot path).

```typescript
const { adapter, stats, close } = await createPgliteAdapter({
  statsLevel: 1, // or 2
});
const prisma = new PrismaClient({ adapter });

afterAll(async () => {
  await prisma.$disconnect();
  await close();
  const s = await stats();
  if (s) console.log(s);
});
```

`stats()` returns `Promise<Stats | null>` — `null` when
`statsLevel` is `0` (or omitted). Safe to call before or after
`close()`; post-close reads return frozen values from the moment
`close()` was invoked.

### Levels

**Level 1** — timing and counters:

- `durationMs` — adapter lifetime (frozen at `close()`, drain
  excluded)
- `wasmInitMs`, `schemaSetupMs` — one-time startup costs
- `queryCount`, `failedQueryCount` — WASM round-trips (a Prisma
  extended-query pipeline is one round-trip, not five)
- `totalQueryMs`, `avgQueryMs`, `p50QueryMs`, `p95QueryMs`,
  `maxQueryMs` — nearest-rank percentiles, no interpolation
- `resetDbCalls` — counts `resetDb()` attempts
- `dbSizeBytes` — `pg_database_size(current_database())`, cached
  at close

**Level 2** — adds:

- `processPeakRssBytes` — process-wide RSS peak (sampled at 500ms,
  a lower bound on true peak — short-lived allocations between
  samples are missed; contaminated if unrelated work shares the
  process)
- `totalSessionLockWaitMs`, `sessionLockAcquisitionCount`,
  `avgSessionLockWaitMs`, `maxSessionLockWaitMs` — session-lock
  contention across pool connections

`statsLevel` is echoed on the returned object. When
`statsLevel === 2`, all level-2 fields are guaranteed defined.
`dbSizeBytes` is the only field that can be `undefined` — if the
`pg_database_size` query rejects (broken pglite state), the rest of
the object still returns.

## Limitations

- **Node.js 20+ only** — requires `node:stream` and `node:fs`.
  Does not work in browsers despite PGlite's browser support.
- **WASM cold start** — first `createPgliteAdapter()` call takes
  ~2s for PGlite WASM compilation. Subsequent calls in the same
  process reuse the compiled module.
- **Single PostgreSQL session** — PGlite runs in single-user mode.
  All pool connections share one session. A `SessionLock` serializes
  transactions (one at a time), but `SET` variables leak between
  connections within a single test. `resetDb()` clears this between
  tests via `RESET ALL` and `DEALLOCATE ALL`.
- **Migration files required** — run `prisma migrate dev` once to
  generate migration files, or pass schema SQL directly via the
  `sql` option.

## Troubleshooting

### `this.pglite.execProtocolRawStream is not a function`

The bridge uses PGlite 0.4's streaming protocol API. Some packages
in the Prisma ecosystem (e.g. `@prisma/dev`) still pin
`@electric-sql/pglite` to 0.3.x, which pnpm will install alongside
0.4 — and the bridge can end up with the older copy.

Check your tree:

```sh
pnpm why @electric-sql/pglite
```

If you see more than one version, force a single 0.4.x via
`pnpm.overrides` in your project's `package.json`:

```json
{
  "pnpm": {
    "overrides": {
      "@electric-sql/pglite": "^0.4.4"
    }
  }
}
```

Then `pnpm install`.

## License

MIT
