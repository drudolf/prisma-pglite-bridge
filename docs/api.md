# API reference

Public exports of `prisma-pglite-bridge`. For end-to-end examples
see the [cookbook](./cookbook.md). For `stats()` snapshots and
diagnostics channels see [stats and diagnostics](./stats.md).
For known limits and runtime warnings see
[troubleshooting](./troubleshooting.md).

## Contents

- [Populating the database](#populating-the-database)
- [`createPGliteBridge(options)`](#createpglitebridgeoptions)
- [`pushMigrations(pglite, options)`](#pushmigrationspglite-options)
- [`pushSchema(adapter, options)`](#pushschemaadapter-options)
- [`resetSchema(adapter)`](#resetschemaadapter)
- [`createPool(options)`](#createpooloptions)
- [`PGliteServer`](#pgliteserver)
- [`PGliteDuplex`](#pgliteduplex)
- [`SessionLock`](#sessionlock)
- [Diagnostics channel exports](#diagnostics-channel-exports)
- [Bridge fs-sync policy](#bridge-fs-sync-policy)

## Populating the database

`createPGliteBridge` returns an empty database. The bridge offers
two helpers to populate it — pick the one that matches your
project layout:

| Helper | When to use | Cost |
| --- | --- | --- |
| [`pushMigrations`](#pushmigrationspglite-options) | You already run `prisma migrate dev` and have a `prisma/migrations` directory | No WASM schema engine; no Node `ExperimentalWarning` |
| [`pushSchema`](#pushschemaadapter-options) | You only have `schema.prisma` (test fixtures, prototypes) and want it applied via `prisma db push` semantics | Loads `@prisma/schema-engine-wasm` once per process |

`pushMigrations` works against any `PGlite` instance directly;
`pushSchema` / `resetSchema` work against any `PrismaPg` adapter
(typically `bridge.adapter`). If you reopen a persistent `dataDir`
that already holds the schema, call neither.

Schema SQL is executed verbatim with no checksum or signature
verification. Compose it from trusted, version-controlled source
only — never from environment variables, network input, or any
value that crosses a trust boundary, and keep the migrations
directory writable only by trusted processes.

## `createPGliteBridge(options)`

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

To apply schema SQL, pass `bridge.pglite` to
[`pushMigrations`](#pushmigrationspglite-options) or `bridge.adapter`
to [`pushSchema`](#pushschemaadapter-options) — see
[Populating the database](#populating-the-database).

Returns a `PGliteBridge`:

- `adapter` — pass to `new PrismaClient({ adapter })`, or to
  `pushSchema` / `resetSchema`
- `pglite` — the caller-supplied PGlite instance, re-exposed for
  passing to `pushMigrations`
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
  `'full'`, else `undefined`. See [stats collection](./stats.md#stats-collection).
- `bridgeId` — a unique `symbol` identifying this bridge. Use it
  to filter events from the public
  [diagnostics channels](./stats.md#diagnostics-channels) when multiple
  bridges share a process.
- `snapshotDb()` — captures the current DB contents into an internal
  snapshot so later `resetDb()` calls restore to that state instead of
  truncating to empty.
- `resetSnapshot()` — discards the current snapshot so later
  `resetDb()` calls truncate back to empty again.

## `pushMigrations(pglite, options)`

Applies SQL migrations directly to a `PGlite` instance. Use this for
projects that already have a `prisma/migrations` directory generated
by `prisma migrate dev`. Does not load `@prisma/schema-engine-wasm`.

```typescript
import { PGlite } from '@electric-sql/pglite';
import { pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite();

// inline SQL
await pushMigrations(pglite, { sql: 'CREATE TABLE ...' });

// from a migrations directory
await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });

// auto-discovered via prisma.config.ts (monorepo: pass configRoot)
await pushMigrations(pglite, { configRoot: process.cwd() });
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

## `pushSchema(adapter, options)`

Applies a Prisma schema to the database via
`@prisma/schema-engine-wasm`, in-process. No native schema-engine
binary, no TCP, no Docker. `prisma generate` still goes through the
regular CLI; only schema apply / reset is bridged.

Use this for projects without a migrations directory — typical of
test fixtures or quick prototypes — or when you want `prisma db
push` semantics (diff `schema.prisma` against the live DB).

Accepts any `PrismaPg` adapter — typically `bridge.adapter`, but any
adapter wired to the target database works.

```typescript
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushSchema } from 'prisma-pglite-bridge';

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });

await pushSchema(bridge.adapter, {
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
[`ExperimentalWarning`](./troubleshooting.md#experimentalwarning-importing-webassembly-module-instances-is-an-experimental-feature)
about WebAssembly imports.

## `resetSchema(adapter)`

Drops every non-system schema and recreates `public`. Useful as a
between-suite reset when you want a clean slate without re-running
all migrations.

```typescript
import { resetSchema } from 'prisma-pglite-bridge';

await resetSchema(bridge.adapter);
```

## `createPool(options)`

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
[diagnostics channel](./stats.md#diagnostics-channels) filtering), and
`close()` (which shuts down the pool only — the caller-supplied
PGlite instance is not closed). Accepts `pglite` (required),
`max`, `bridgeId`, and `syncToFs`.

## `PGliteServer`

Exposes a PGlite instance over TCP or a Unix domain socket so
standard PostgreSQL clients can connect. Useful for the Prisma CLI
shadow database, `psql`, and SQL GUIs.

```typescript
import { PGliteServer } from 'prisma-pglite-bridge';

const server = new PGliteServer({ pglite });
const url = await server.listen();
// url → 'postgres://postgres@127.0.0.1:54321/postgres'
```

See the dedicated guide: [`PGliteServer`](./server.md) —
options, Unix-socket mode, shadow-database wiring, and security
notes.

## `PGliteDuplex`

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

## `SessionLock`

An async mutex that serializes PGlite access across multiple
duplex streams sharing one PGlite instance. `createPGliteBridge`
and `createPool` install one automatically; export it for custom
multi-duplex setups built on top of `PGliteDuplex`.

## Diagnostics channel exports

`QUERY_CHANNEL`, `LOCK_WAIT_CHANNEL`, and the matching
`QueryEvent` / `LockWaitEvent` types are exported for subscribing
to live per-query and per-lock-wait events. See
[diagnostics channels](./stats.md#diagnostics-channels) for the wiring.

## Bridge fs-sync policy

The bridge defaults `syncToFs` to `'auto'`:

- in-memory PGlite (`new PGlite()` or `memory://...`) resolves to `false`
- persistent `dataDir` usage resolves to `true`

That keeps bridge-heavy test workloads on the lower-memory fast path
without changing durability defaults for persistent databases.
If you use a custom `fs`, set `syncToFs` explicitly because the
bridge cannot infer whether that storage is durable.
