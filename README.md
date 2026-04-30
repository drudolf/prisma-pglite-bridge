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
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });

const prisma = new PrismaClient({ adapter: bridge.adapter });

beforeEach(() => bridge.resetDb());
```

Call `resetDb()` in `beforeEach` to wipe all data between tests.
Skip it if your tests are read-only or you want state to carry
over.

That's it. Run `prisma migrate dev` first to generate migration
files. No Docker, no database server — works in GitHub Actions,
GitLab CI, and any environment where Node.js runs.

## Populating the database

`createPGliteBridge` returns an empty database. The bridge offers
two helpers to populate it — pick the one that matches your
project layout:

| Helper | When to use | Cost |
| --- | --- | --- |
| [`pushMigrations`](#pushmigrationstarget-options) | You already run `prisma migrate dev` and have a `prisma/migrations` directory | No WASM schema engine; no Node `ExperimentalWarning` |
| [`pushSchema`](#pushschematarget-options) | You only have `schema.prisma` (test fixtures, prototypes) and want it applied via `prisma db push` semantics | Loads `@prisma/schema-engine-wasm` once per process |

Both accept the same `PGliteBridge` returned by
`createPGliteBridge`, so you can swap helpers without touching the
bridge wiring. If you reopen a persistent `dataDir` that already
holds the schema, call neither.

Schema SQL is executed verbatim with no checksum or signature
verification. Compose it from trusted, version-controlled source
only — never from environment variables, network input, or any
value that crosses a trust boundary, and keep the migrations
directory writable only by trusted processes.

## Bridge fs-sync policy

The bridge defaults `syncToFs` to `'auto'`:

- in-memory PGlite (`new PGlite()` or `memory://...`) resolves to `false`
- persistent `dataDir` usage resolves to `true`

That keeps bridge-heavy test workloads on the lower-memory fast path
without changing durability defaults for persistent databases.
If you use a custom `fs`, set `syncToFs` explicitly because the
bridge cannot infer whether that storage is durable.

## API

### `createPGliteBridge(options)`

Creates a `PGliteBridge` — a bundle holding a Prisma driver adapter,
the underlying PGlite instance, and lifecycle helpers — backed by a
caller-supplied PGlite instance.

```typescript
const pglite = new PGlite(/* dataDir, extensions, ... */);

const bridge = await createPGliteBridge({
  pglite,                     // required — caller owns lifecycle
  max: 1,                     // pool connections (default: 1)
  statsLevel: 'off',          // 'off' | 'basic' | 'full' (default: 'off')
  syncToFs: 'auto',           // 'auto' | true | false (default: 'auto')
});
```

To apply schema SQL, call [`pushMigrations`](#pushmigrationstarget-options)
or [`pushSchema`](#pushschematarget-options) on the returned
bridge — see [Populating the database](#populating-the-database).

Returns a `PGliteBridge`:

- `adapter` — pass to `new PrismaClient({ adapter })`
- `pglite` — the caller-supplied PGlite instance, re-exposed for
  symmetry with `pushSchema` / `pushMigrations`
- `resetDb()` — truncates all user tables and discards
  session-local state via `DISCARD ALL` (for example `SET`
  variables, prepared statements, temp tables, and `LISTEN`
  registrations). Call in `beforeEach` for per-test isolation.
  Note: this clears all data including seed data — re-seed after
  reset if needed.
- `close()` — shuts down the pool. The caller-supplied PGlite
  instance is not closed — you own its lifecycle. Recommended in
  explicit test teardown, long-running scripts, and dev servers so
  the pool is released promptly and leak warnings do not fire.
- `stats()` — returns telemetry when `statsLevel` is `'basic'` or
  `'full'`, else `undefined`. See [Stats collection](#stats-collection).
- `bridgeId` — a unique `symbol` identifying this bridge. Use it
  to filter events from the public
  [diagnostics channels](#diagnostics-channels) when multiple
  bridges share a process.
- `snapshotDb()` — captures the current DB contents into an internal
  snapshot so later `resetDb()` calls restore to that state instead of
  truncating to empty.
- `resetSnapshot()` — discards the current snapshot so later
  `resetDb()` calls truncate back to empty again.

### `pushMigrations(target, options)`

Applies SQL migrations to a `PGliteBridge`. Use this for projects
that already have a `prisma/migrations` directory generated by
`prisma migrate dev`. Does not load `@prisma/schema-engine-wasm`.

```typescript
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const bridge = await createPGliteBridge({ pglite });

// inline SQL
await pushMigrations(bridge, { sql: 'CREATE TABLE ...' });

// from a migrations directory
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });

// auto-discovered via prisma.config.ts (monorepo: pass configRoot)
await pushMigrations(bridge, { configRoot: process.cwd() });
```

Resolution order — first match wins:

1. **`sql` option** — pre-generated SQL string, applied directly
2. **`migrationsPath` option** — concatenates every
   `migration.sql` found one directory level below, in
   directory-name order
3. **Auto-discovered migrations** — uses `@prisma/config` to find
   migration files (same resolution as `prisma migrate dev`),
   triggered by passing `configRoot`. Requires `prisma` to be
   installed (which provides `@prisma/config` as a transitive
   dependency).

Returns `{ durationMs }` — the wall-clock time PGlite spent applying
the SQL, useful when you want to log schema-setup cost.

### `pushSchema(target, options)`

Applies a Prisma schema to the database via
`@prisma/schema-engine-wasm`, in-process. No native schema-engine
binary, no TCP, no Docker. `prisma generate` still goes through the
regular CLI; only schema apply / reset is bridged.

Use this for projects without a migrations directory — typical of
test fixtures or quick prototypes — or when you want `prisma db
push` semantics (diff `schema.prisma` against the live DB).

```typescript
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushSchema } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });

await pushSchema(bridge, {
  schema: await readFile('prisma/schema.prisma', 'utf8'),
  // acceptDataLoss: true,  // apply destructive changes flagged as warnings
  // forceReset: true,      // drop every non-system schema before applying
});
```

Returns `{ executedSteps, warnings, unexecutable }`.
`acceptDataLoss: true` lets the engine apply destructive changes
that would otherwise be reported as warnings; `unexecutable` steps
are independent — the engine refuses them either way and the
caller must reshape the schema. `forceReset: true` drops every
non-system schema before applying.

The first call in a Node process emits an
[`ExperimentalWarning`](#experimentalwarning-importing-webassembly-module-instances-is-an-experimental-feature)
about WebAssembly imports.

### `resetSchema(target)`

Drops every non-system schema and recreates `public`. Useful as a
between-suite reset when you want a clean slate without re-running
all migrations.

```typescript
import { resetSchema } from 'prisma-pglite-bridge';

await resetSchema(bridge);
```

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

Returns `pool` (pg.Pool), `bridgeId` (a unique `symbol` for
[diagnostics channel](#diagnostics-channels) filtering), and
`close()` (which shuts down the pool only — the caller-supplied
PGlite instance is not closed). Accepts `pglite` (required),
`max`, `bridgeId`, and `syncToFs`.

### `PGliteDuplex`

The Duplex stream that replaces `pg.Client`'s network socket.
Exported for advanced use cases (custom `pg.Client` setup, direct
wire protocol access). When using multiple duplex streams against
the same PGlite instance, pass a shared `SessionLock` to prevent
transaction interleaving.

```typescript
import { PGliteDuplex, SessionLock } from 'prisma-pglite-bridge';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

const pglite = new PGlite();
await pglite.waitReady;

const lock = new SessionLock();
const client = new pg.Client({
  stream: () => new PGliteDuplex(pglite, lock),
});
```

### `SessionLock`

An async mutex that serializes PGlite access across multiple
duplex streams sharing one PGlite instance. `createPGliteBridge`
and `createPool` install one automatically; export it for custom
multi-duplex setups built on top of `PGliteDuplex`.

### Diagnostics channel exports

`QUERY_CHANNEL`, `LOCK_WAIT_CHANNEL`, and the matching
`QueryEvent` / `LockWaitEvent` types are exported for subscribing
to live per-query and per-lock-wait events. See
[Diagnostics channels](#diagnostics-channels) for the wiring.

## CLI (`ppb`)

The `ppb` CLI exposes [`pushSchema`](#pushschematarget-options) and
[`resetSchema`](#resetschematarget) as standalone commands so you
can apply a Prisma schema to a PGlite database without writing
glue code.

```sh
pnpm exec ppb db-push   [--schema <path>]            # default: prisma/schema.prisma
                        [--force-reset]
                        [--accept-data-loss]
                        [--data-dir <path>]          # overrides DATABASE_URL
pnpm exec ppb db-reset  [--data-dir <path>]
```

`DATABASE_URL` is read from env / `.env` and parsed as a `pglite://`
URL — `pglite://memory` for in-memory, `pglite:///abs/path` or
`pglite://./rel/path` for filesystem-backed PGlite. `--data-dir`
overrides it.

Exit codes:

- **0** — success.
- **1** — engine reported `unexecutable` steps, or `warnings` were
  reported and `--accept-data-loss` was not supplied, or the
  schema failed to parse / push.

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
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { beforeEach, vi } from 'vitest';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
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
  await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
  testPrisma = new PrismaClient({ adapter: bridge.adapter });
  resetDb = bridge.resetDb;
});

beforeEach(() => resetDb());
```

### Vitest with per-test isolation (no singleton)

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
  await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
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
import { createPGliteBridge, pushMigrations, type ResetDbFn } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import { seed } from '../prisma/seed';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  const pglite = new PGlite();
  const bridge = await createPGliteBridge({ pglite });
  await pushMigrations(result, { migrationsPath: './prisma/migrations' });
  prisma = new PrismaClient({ adapter: bridge.adapter });
  resetDb = bridge.resetDb;
  await seed(prisma);
});

// resetDb() clears all data — re-seed if needed
beforeEach(async () => {
  await resetDb();
  await seed(prisma);
});
```

### Applying a schema directly (no migrations directory)

For test fixtures or prototypes without `prisma/migrations`, swap
`pushMigrations` for `pushSchema`:

```typescript
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushSchema } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushSchema(bridge, {
  schema: await readFile('prisma/schema.prisma', 'utf8'),
});
```

### Using PostgreSQL extensions

If your schema uses `uuid-ossp`, `pgcrypto`, or other extensions,
pass them via the `extensions` option:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const pglite = new PGlite({ extensions: { uuid_ossp, pgcrypto } });
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
```

Extensions are included in the `@electric-sql/pglite` package —
no extra install needed. See [PGlite extensions](https://pglite.dev/extensions/)
for the full list.

### Pre-generated SQL (fastest)

The `sql` option on `pushMigrations` runs verbatim with no sandbox
or checksum. Compose it from trusted, version-controlled source
only — never from environment variables, network input, or values
that cross a trust boundary.

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(bridge, {
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
const bridge = await createPGliteBridge({ pglite });
if (firstRun) await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });
```

**Add `data/pglite/` to `.gitignore`.** Delete the data directory
after schema changes to pick up new migrations. This gives you a
local PostgreSQL without Docker — useful for offline development
or environments where installing PostgreSQL is impractical.

### Long-running script with clean shutdown

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });

try {
  await seedDatabase(prisma);
} finally {
  await prisma.$disconnect();
  await bridge.close();
  await pglite.close();
}
```

## Stats collection

For most developers, this is the easiest way to see how the bridge
performed in tests.

Enable `statsLevel` when creating the bridge, run your tests, then
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
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({
  pglite,
  statsLevel: 'basic', // or 'full'
});
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
const prisma = new PrismaClient({ adapter: bridge.adapter });

afterAll(async () => {
  await prisma.$disconnect();
  await bridge.close();
  const s = await bridge.stats();
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

- `durationMs` — bridge lifetime (frozen at `close()`, drain
  excluded)
- `queryCount`, `failedQueryCount` — WASM round-trips (a Prisma
  extended-query pipeline is one round-trip, not five). Lifetime
  counters.
- `totalQueryMs`, `avgQueryMs` — lifetime sum and mean of query
  durations
- `recentP50QueryMs`, `recentP95QueryMs`, `recentMaxQueryMs` —
  nearest-rank percentiles (no interpolation) over the most recent
  ~10,000 queries. On long-lived bridges these describe a different
  population than `avgQueryMs`.
- `resetDbCalls` — counts `resetDb()` attempts
- `dbSizeBytes` — `pg_database_size(current_database())`, cached
  at close

**`'full'`** — adds:

- `processRssPeakBytes` — process-wide RSS peak, read from
  `process.resourceUsage().maxRSS` (kernel-tracked, lossless) at
  the moment `stats()` is called. Contaminated if unrelated work
  shares the process — use as an ordering signal, not an absolute
  measurement. `undefined` on runtimes without
  `process.resourceUsage` (Bun, Deno, edge workers).
- `totalSessionLockWaitMs`, `sessionLockAcquisitionCount`,
  `avgSessionLockWaitMs`, `maxSessionLockWaitMs` — session-lock
  contention across pool connections

`statsLevel` is echoed on the returned object. Any field typed
`T | undefined` in the returned `Stats` is the exhaustive list of
fields that can be missing — `dbSizeBytes` if `pg_database_size`
rejects, `processRssPeakBytes` on runtimes without
`process.resourceUsage`. Every other field is always defined.

## Diagnostics channels

The bridge publishes per-query and per-lock-wait events to
[`node:diagnostics_channel`](https://nodejs.org/api/diagnostics_channel.html)
channels. Built-in bridge stats are updated directly by the bridge
when `statsLevel` is `'basic'` or `'full'`; external consumers (OpenTelemetry, APM,
custom loggers) can subscribe directly without touching the bridge
API.

Publication is gated by `channel.hasSubscribers`, so when nobody
is listening the hot path pays no timing or payload cost.
Subscribing opts you in to that work.

```typescript
import diagnostics_channel from 'node:diagnostics_channel';
import {
  createPGliteBridge,
  QUERY_CHANNEL,
  type QueryEvent,
} from 'prisma-pglite-bridge';

const { bridgeId } = await createPGliteBridge({ /* ... */ });

const listener = (msg: unknown) => {
  const e = msg as QueryEvent;
  if (e.bridgeId !== bridgeId) return;
  myMetrics.record('db.query', e.durationMs, { ok: e.succeeded });
};
diagnostics_channel.channel(QUERY_CHANNEL).subscribe(listener);
```

Channels:

- `QUERY_CHANNEL` (`prisma-pglite-bridge:query`) — every
  whole-query boundary. Payload: `{ bridgeId: symbol; durationMs:
  number; succeeded: boolean }`. `succeeded` is `false` for both
  thrown errors and protocol-level `ErrorResponse` frames.
- `LOCK_WAIT_CHANNEL` (`prisma-pglite-bridge:lock-wait`) — every
  session-lock acquisition. Payload: `{ bridgeId: symbol;
  durationMs: number }`. `durationMs` is how long the acquirer
  waited before the lock was granted.

Filter on `bridgeId` to isolate events when multiple bridges
share a process. Obtain it from the `createPGliteBridge()` or
`createPool()` return value.

## Limitations

- **Node.js 20+ only** — requires `node:stream` and `node:fs`.
  Does not work in browsers despite PGlite's browser support.
- **WASM cold start** — first `createPGliteBridge()` call takes
  ~2s for PGlite WASM compilation. Subsequent calls in the same
  process reuse the compiled module.
- **Single PostgreSQL session** — PGlite runs in single-user mode.
  All pool connections share one session. With `max > 1`, a
  `SessionLock` serializes transactions (one at a time), but `SET`
  variables leak between connections within a single test. `resetDb()`
  clears more of this between tests via `DISCARD ALL`. The default
  `max: 1` avoids extra bridge connections and session-lock overhead.
- **Schema source required** — pick one of
  [`pushMigrations`](#pushmigrationstarget-options) (run
  `prisma migrate dev` first or pass `sql` directly) or
  [`pushSchema`](#pushschematarget-options) (apply
  `schema.prisma` directly). `createPGliteBridge` alone returns
  an empty database.

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

### `ExperimentalWarning: Importing WebAssembly module instances is an experimental feature`

Emitted by Node when `pushSchema` / `resetSchema` (or the `ppb` CLI)
loads `@prisma/schema-engine-wasm`, which uses ESM static `.wasm`
imports. The warning is harmless and prints once per Node process.

If you only need to apply already-generated migration SQL, use
[`pushMigrations`](#pushmigrationstarget-options) instead — it does
not load the schema engine, so the warning never fires.

To silence it in tests or CI, pass Node's `--disable-warning` flag:

```sh
NODE_OPTIONS=--disable-warning=ExperimentalWarning pnpm test
```

Or scope it to Vitest workers via `vitest.config.ts`:

```ts
export default defineConfig({
  test: {
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
```

Requires Node ≥ 22. The warning will go away once Node stabilizes
WebAssembly ESM imports.

## License

MIT
