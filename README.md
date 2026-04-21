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

### Optional PGlite 0.4.4 memory patch

`@electric-sql/pglite@0.4.4` retains parsed raw-protocol messages
across `execProtocolRaw()` / `execProtocolRawStream()` calls. That
shows up as large memory growth on the bridge path because this
package uses PGlite's raw wire-protocol API.

This repo ships a version-pinned patch for `@electric-sql/pglite@0.4.4`
in [patches/@electric-sql__pglite@0.4.4.patch](patches/@electric-sql__pglite@0.4.4.patch).
We apply it in development via `pnpm.patchedDependencies`.

If your project also uses `@electric-sql/pglite@0.4.4`, you can opt
into the same fix. This workflow is `pnpm`-specific.

#### How To Apply It In Your Project

1. Make sure your project is actually using
   `@electric-sql/pglite@0.4.4`.

```sh
pnpm add -D @electric-sql/pglite@0.4.4
pnpm why @electric-sql/pglite
```

If you are also setting up `prisma-pglite-bridge`, install it
separately as usual.

1. Install `prisma-pglite-bridge` so the patch file is available in
   `node_modules`:

```sh
pnpm add -D prisma-pglite-bridge
```

1. Copy the shipped patch file into your own repo:

```sh
mkdir -p patches
cp node_modules/prisma-pglite-bridge/patches/@electric-sql__pglite@0.4.4.patch \
  patches/@electric-sql__pglite@0.4.4.patch
```

1. Add this to your project's `package.json`:

```json
{
  "pnpm": {
    "patchedDependencies": {
      "@electric-sql/pglite@0.4.4": "patches/@electric-sql__pglite@0.4.4.patch"
    }
  }
}
```

1. Reinstall so `pnpm` applies the patch:

```sh
pnpm install
```

1. Verify that the patch is active in `pnpm-lock.yaml`.

You should see:

- a top-level `patchedDependencies` entry for `@electric-sql/pglite@0.4.4`
- patched package keys that include `patch_hash=...`

This patch is intentionally version-specific. Do not apply it to
other PGlite versions unless the patch has been validated for that
exact release.

## Quickstart

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPgliteAdapter } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';

const pglite = new PGlite();
const { adapter, resetDb } = await createPgliteAdapter({
  pglite,
  migrationsPath: './prisma/migrations',
});
const prisma = new PrismaClient({ adapter });

// Per-test isolation (optional)
beforeEach(() => resetDb());
```

That's it. Run `prisma migrate dev` first to generate migration
files. No Docker, no database server — works in GitHub Actions,
GitLab CI, and any environment where Node.js runs.

## Schema Resolution

When you pass any of `sql`, `migrationsPath`, or `configRoot`,
`createPgliteAdapter` applies schema SQL. Resolution order:

1. **`sql` option** — pre-generated SQL string, applied directly
2. **`migrationsPath` option** — reads migration files from the
   given directory
3. **Auto-discovered migrations** — uses `@prisma/config` to find
   migration files (same resolution as `prisma migrate dev`),
   triggered by passing `configRoot`. Requires `prisma` to be
   installed (which provides `@prisma/config` as a transitive
   dependency).

When none of these options is provided, no SQL is applied — the
PGlite instance is assumed to already hold the schema (useful
for reopening a persistent `dataDir`).

## API

### `createPgliteAdapter(options)`

Creates a Prisma adapter backed by a caller-supplied PGlite
instance.

```typescript
const pglite = new PGlite(/* dataDir, extensions, ... */);

const { adapter, resetDb, close, stats } = await createPgliteAdapter({
  pglite,                                // required — caller owns lifecycle
  migrationsPath: './prisma/migrations', // or:
  sql: 'CREATE TABLE ...',              // (first match wins, see Schema Resolution)
  configRoot: '../..',        // monorepo: where to find prisma.config.ts
  max: 1,                     // pool connections (default: 1, see "Pool sizing" below)
  statsLevel: 'off',          // 'off' | 'basic' | 'full' (default: 'off')
});
```

Returns:

- `adapter` — pass to `new PrismaClient({ adapter })`
- `resetDb()` — truncates all user tables and discards
  session-local state via `DISCARD ALL` (for example `SET`
  variables, prepared statements, temp tables, and `LISTEN`
  registrations). Call in `beforeEach` for per-test isolation.
  Note: this clears all data including seed data — re-seed after
  reset if needed.
- `close()` — shuts down the pool. The caller-supplied PGlite
  instance is not closed — you own its lifecycle. Not needed in
  tests (process exit handles it); use in long-running scripts
  or dev servers.
- `stats()` — returns telemetry when `statsLevel` is `'basic'` or
  `'full'`, else `undefined`. See [Stats collection](#stats-collection).
- `adapterId` — a unique `symbol` identifying this adapter. Use it
  to filter events from the public
  [diagnostics channels](#diagnostics-channels) when multiple
  adapters share a process.

### `createPool(options)`

Lower-level escape hatch. Creates a `pg.Pool` backed by PGlite
without schema handling — useful for custom Prisma setups,
other ORMs, or raw SQL.

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPool } from 'prisma-pglite-bridge';
import { PrismaPg } from '@prisma/adapter-pg';

const pglite = new PGlite();
const { pool, close } = await createPool({ pglite });
const adapter = new PrismaPg(pool);
```

Returns `pool` (pg.Pool), `adapterId` (a unique `symbol` for
[diagnostics channel](#diagnostics-channels) filtering), and
`close()` (which shuts down the pool only — the caller-supplied
PGlite instance is not closed). Accepts `pglite` (required),
`max`, and `adapterId`.

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
import { PGlite } from '@electric-sql/pglite';
import { createPgliteAdapter } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';

const pglite = new PGlite();
const { adapter, resetDb } = await createPgliteAdapter({
  pglite,
  migrationsPath: './prisma/migrations',
});
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
const { PGlite } = require('@electric-sql/pglite');
const { createPgliteAdapter } = require('prisma-pglite-bridge');
const { PrismaClient } = require('@prisma/client');

let testPrisma;
let resetDb;

jest.mock('./lib/prisma', () => ({
  get prisma() { return testPrisma; },
}));

beforeAll(async () => {
  const pglite = new PGlite();
  const result = await createPgliteAdapter({
    pglite,
    migrationsPath: './prisma/migrations',
  });
  testPrisma = new PrismaClient({ adapter: result.adapter });
  resetDb = result.resetDb;
});

beforeEach(() => resetDb());
```

### Vitest with per-test isolation (no singleton)

If your code accepts `PrismaClient` as a parameter:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPgliteAdapter, type ResetDbFn } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, it, expect } from 'vitest';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  const pglite = new PGlite();
  const result = await createPgliteAdapter({
    pglite,
    migrationsPath: './prisma/migrations',
  });
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
import { PGlite } from '@electric-sql/pglite';
import { createPgliteAdapter, type ResetDbFn } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  const pglite = new PGlite();
  const result = await createPgliteAdapter({
    pglite,
    migrationsPath: './prisma/migrations',
  });
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
import { PGlite } from '@electric-sql/pglite';
import { createPgliteAdapter } from 'prisma-pglite-bridge';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const pglite = new PGlite({ extensions: { uuid_ossp, pgcrypto } });
const { adapter } = await createPgliteAdapter({
  pglite,
  migrationsPath: './prisma/migrations',
});
```

Extensions are included in the `@electric-sql/pglite` package —
no extra install needed. See [PGlite extensions](https://pglite.dev/extensions/)
for the full list.

### Pre-generated SQL (fastest)

```typescript
import { PGlite } from '@electric-sql/pglite';

const pglite = new PGlite();
const { adapter } = await createPgliteAdapter({
  pglite,
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
const { adapter, close } = await createPgliteAdapter({
  pglite,
  ...(firstRun ? { migrationsPath: './prisma/migrations' } : {}),
});
const prisma = new PrismaClient({ adapter });
```

**Add `data/pglite/` to `.gitignore`.** Delete the data directory
after schema changes to pick up new migrations. This gives you a
local PostgreSQL without Docker — useful for offline development
or environments where installing PostgreSQL is impractical.

### Long-running script with clean shutdown

```typescript
import { PGlite } from '@electric-sql/pglite';

const pglite = new PGlite();
const { adapter, close } = await createPgliteAdapter({
  pglite,
  migrationsPath: './prisma/migrations',
});
const prisma = new PrismaClient({ adapter });

try {
  await seedDatabase(prisma);
} finally {
  await prisma.$disconnect();
  await close();
  await pglite.close();
}
```

## Stats collection

For most developers, this is the easiest way to see how the bridge
performed in tests.

Enable `statsLevel` when creating the adapter, run your tests, then
call `await stats()` at the end. You get one snapshot with the main
things you usually care about: query counts, timing percentiles,
database size, and, at `'full'`, process RSS and session-lock wait
times.

This is the built-in, low-friction path for test diagnostics. It is
useful for CI cost insight, perf tuning, and understanding test-suite
behavior without wiring up a separate metrics pipeline. **Off by
default**; the hot path stays effectively zero-cost as long as no
external consumer subscribes to the public
[diagnostics channels](#diagnostics-channels).

```typescript
import { PGlite } from '@electric-sql/pglite';

const pglite = new PGlite();
const { adapter, stats, close } = await createPgliteAdapter({
  pglite,
  migrationsPath: './prisma/migrations',
  statsLevel: 'basic', // or 'full'
});
const prisma = new PrismaClient({ adapter });

afterAll(async () => {
  await prisma.$disconnect();
  await close();
  const s = await stats();
  if (s) console.log(s);
  await pglite.close();
});
```

`stats()` returns `Promise<Stats | undefined>` — `undefined` when
`statsLevel` is `'off'` (or omitted). Safe to call before or after
`close()`; post-close reads return frozen values from the moment
`close()` was invoked.

If you need live per-query or per-lock-wait events instead of a final
snapshot, use the public [diagnostics channels](#diagnostics-channels)
described below. That path is more flexible, but also more advanced.

### Levels

**`'basic'`** — timing and counters:

- `durationMs` — adapter lifetime (frozen at `close()`, drain
  excluded)
- `schemaSetupMs` — one-time cost of applying migration SQL
- `queryCount`, `failedQueryCount` — WASM round-trips (a Prisma
  extended-query pipeline is one round-trip, not five). Lifetime
  counters.
- `totalQueryMs`, `avgQueryMs` — lifetime sum and mean of query
  durations
- `recentP50QueryMs`, `recentP95QueryMs`, `recentMaxQueryMs` —
  nearest-rank percentiles (no interpolation) over the most recent
  ~10,000 queries. On long-lived adapters these describe a different
  population than `avgQueryMs`.
- `resetDbCalls` — counts `resetDb()` attempts
- `dbSizeBytes` — `pg_database_size(current_database())`, cached
  at close

**`'full'`** — adds:

- `processRssPeakBytes` — process-wide RSS peak (sampled at 500ms,
  a lower bound on true peak — short-lived allocations between
  samples are missed; contaminated if unrelated work shares the
  process)
- `totalSessionLockWaitMs`, `sessionLockAcquisitionCount`,
  `avgSessionLockWaitMs`, `maxSessionLockWaitMs` — session-lock
  contention across pool connections

`statsLevel` is echoed on the returned object. When
`statsLevel === 'full'`, all `'full'`-only fields are guaranteed
defined. `dbSizeBytes` is the only field that can be `undefined` — if the
`pg_database_size` query rejects (broken pglite state), the rest of
the object still returns.

## Diagnostics channels

The bridge publishes per-query and per-lock-wait events to
[`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
channels. Built-in adapter stats are updated directly by the bridge
when `statsLevel` is `'basic'` or `'full'`; external consumers (OpenTelemetry, APM,
custom loggers) can subscribe directly without touching the bridge
API.

Publication is gated by `channel.hasSubscribers`, so when nobody
is listening the hot path pays no timing or payload cost.
Subscribing opts you in to that work.

```typescript
import diagnostics_channel from 'node:diagnostics_channel';
import {
  createPgliteAdapter,
  QUERY_CHANNEL,
  type QueryEvent,
} from 'prisma-pglite-bridge';

const { adapterId } = await createPgliteAdapter({ /* ... */ });

const listener = (msg: unknown) => {
  const e = msg as QueryEvent;
  if (e.adapterId !== adapterId) return;
  myMetrics.record('db.query', e.durationMs, { ok: e.succeeded });
};
diagnostics_channel.channel(QUERY_CHANNEL).subscribe(listener);
```

Channels:

- `QUERY_CHANNEL` (`prisma-pglite-bridge:query`) — every
  whole-query boundary. Payload: `{ adapterId: symbol; durationMs:
  number; succeeded: boolean }`. `succeeded` is `false` for both
  thrown errors and protocol-level `ErrorResponse` frames.
- `LOCK_WAIT_CHANNEL` (`prisma-pglite-bridge:lock-wait`) — every
  session-lock acquisition. Payload: `{ adapterId: symbol;
  durationMs: number }`. `durationMs` is how long the acquirer
  waited before the lock was granted.

Filter on `adapterId` to isolate events when multiple adapters
share a process. Obtain it from the `createPgliteAdapter()` or
`createPool()` return value.

## Limitations

- **Node.js 20+ only** — requires `node:stream` and `node:fs`.
  Does not work in browsers despite PGlite's browser support.
- **WASM cold start** — first `createPgliteAdapter()` call takes
  ~2s for PGlite WASM compilation. Subsequent calls in the same
  process reuse the compiled module.
- **Single PostgreSQL session** — PGlite runs in single-user mode.
  All pool connections share one session. A `SessionLock` serializes
  transactions (one at a time), but `SET` variables leak between
  connections within a single test. `resetDb()` clears more of this
  between tests via `DISCARD ALL`.
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
