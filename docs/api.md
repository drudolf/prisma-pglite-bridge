# API reference

Public exports of `prisma-pglite-bridge`. For end-to-end examples
see the [cookbook](./cookbook.md). For `stats()` snapshots and
diagnostics channels see [stats and diagnostics](./stats.md).
For known limits and runtime warnings see
[troubleshooting](./troubleshooting.md).

## Contents

- [Terminology: Bridge vs Duplex](#terminology-bridge-vs-duplex)
- [Populating the database](#populating-the-database)
- [`PGliteBridge`](#pglitebridge)
- [`pushMigrations(pglite, options)`](#pushmigrationspglite-options)
- [`pushSchema(adapter, options)`](#pushschemaadapter-options)
- [`resetSchema(adapter)`](#resetschemaadapter)
- [`hasMigrations(pglite)`](#hasmigrationspglite)
- [`hasSchema(pglite)`](#hasschemapglite)
- [`PgBridgePool`](#pgbridgepool)
- [`PGliteServer`](#pgliteserver)
- [`PGliteDuplex`](#pgliteduplex)
- [`SessionLock`](#sessionlock)
- [Diagnostics channel exports](#diagnostics-channel-exports)
- [Bridge fs-sync policy](#bridge-fs-sync-policy)

## Terminology: Bridge vs Duplex

This package uses two related but distinct terms:

- **Bridge** is the package concept and the high-level surface
  (`PGliteBridge`, `PgBridgePool`). A bridge wraps a `PGlite`
  instance and exposes an adapter / pool that Prisma can talk to
  as if it were a real PostgreSQL server.
- **Duplex** is the wire-protocol layer (`PGliteDuplex`). It is a
  Node `Duplex` stream that stands in for `pg.Client`'s network
  socket — speaking the PostgreSQL wire protocol on one side and
  calling PGlite directly on the other. Each pool connection owns
  one `PGliteDuplex`. Reach for it directly only when wiring a
  custom `pg.Client` setup outside of `PgBridgePool`.

`PGliteServer` is an optional TCP/Unix-socket wrapper that exposes
a duplex over a real network socket — used for the Prisma CLI
shadow database, `psql`, and other tools that demand a server URL.

## Populating the database

`new PGliteBridge(...)` wraps an empty database. The bridge offers
two helpers to populate it — pick the one that matches your
project layout:

| Helper | When to use | Cost |
| --- | --- | --- |
| [`pushMigrations`](#pushmigrationspglite-options) | You already run `prisma migrate dev` and have a `prisma/migrations` directory | No WASM schema engine; no Node `ExperimentalWarning` |
| [`pushSchema`](#pushschemaadapter-options) | You only have `schema.prisma` (test fixtures, prototypes) and want it applied via `prisma db push` semantics | Loads `@prisma/schema-engine-wasm` once per process |

`pushMigrations` works against any `PGlite` instance directly;
`pushSchema` / `resetSchema` work against any `PrismaPg` adapter
(typically `bridge.adapter`). If you reopen a persistent `dataDir`
that already holds the schema, call neither — guard the call with
[`hasMigrations`](#hasmigrationspglite) (Prisma migrations) or
[`hasSchema`](#hasschemapglite) (any user table) so the apply step
runs only on a fresh dataDir.

Schema SQL is executed verbatim with no checksum or signature
verification. Compose it from trusted, version-controlled source
only — never from environment variables, network input, or any
value that crosses a trust boundary, and keep the migrations
directory writable only by trusted processes.

## `PGliteBridge`

A class bundling a Prisma driver adapter, the underlying PGlite
instance, and lifecycle helpers. Construct synchronously; the
bridge awaits `pglite.waitReady` internally on the first operation.

**Ownership:** when no `pglite` is passed the bridge creates its own
in-memory PGlite and owns it — `close()` shuts it down. When you
supply a `pglite`, the bridge treats it as caller-owned and `close()`
leaves it open.

```typescript
import { PGliteBridge } from 'prisma-pglite-bridge';

// Bridge creates and owns its own in-memory PGlite:
const bridge = new PGliteBridge({
  max: 1,                     // pool connections (default: 1)
  statsLevel: 'off',          // 'off' | 'basic' | 'full' (default: 'off')
  syncToFs: 'auto',           // 'auto' | true | false (default: 'auto')
  preparedStatements: true,   // cache queries as named statements (default: on at max 1)
});

// Caller-supplied PGlite (custom dataDir, extensions, …) — caller owns lifecycle:
import { PGlite } from '@electric-sql/pglite';
const pglite = new PGlite(/* dataDir, extensions, ... */);
const bridge = new PGliteBridge({ pglite });
// bridge.close() closes the pool only; call pglite.close() yourself when done
```

The constructor takes a `PGliteBridgeOptions` (also exported).
Prepared-statement caching is on by default at `max: 1` — each Prisma
query shape is parsed and planned once per session; statements
survive `resetDb`. Pass `preparedStatements: false` when other
pools/bridges share this bridge's live PGlite instance, or when you
run result-type-changing DDL mid-session — see
[troubleshooting](./troubleshooting.md) for both symptoms. To
apply schema SQL, pass `bridge.pglite` to
[`pushMigrations`](#pushmigrationspglite-options) or `bridge.adapter`
to [`pushSchema`](#pushschemaadapter-options) — see
[Populating the database](#populating-the-database).

Instance members:

- `adapter` — `PrismaPg` adapter; pass to
  `new PrismaClient({ adapter })`, or to `pushSchema` /
  `resetSchema`.
- `pglite` — the PGlite instance this bridge wraps (created
  internally or caller-supplied). Pass it to `pushMigrations`,
  `hasMigrations`, `hasSchema`, etc.
- `bridgeId` — a unique `symbol` identifying this bridge. Use it
  to filter events from the public
  [diagnostics channels](./stats.md#diagnostics-channels) when multiple
  bridges share a process.
- `resetDb()` — truncates all user tables and discards
  session-local state via `DISCARD ALL` (for example `SET`
  variables, prepared statements, temp tables, and `LISTEN`
  registrations). Call in `beforeEach` for per-test isolation.
  Note: this clears all data including seed data — re-seed after
  reset (or use `snapshotDb()` first) if needed.
- `snapshotDb()` — captures the current DB contents into an internal
  snapshot so later `resetDb()` calls restore to that state instead of
  truncating to empty.
- `resetSnapshot()` — discards the current snapshot so later
  `resetDb()` calls truncate back to empty again.
- `stats()` — returns telemetry when `statsLevel` is `'basic'` or
  `'full'`, else `undefined`. See [stats collection](./stats.md#stats-collection).
- `close()` — shuts down the pool. When the bridge created its own
  PGlite, also closes it. When you supplied a `pglite`, it is left
  open — you own its lifecycle. Recommended in explicit test
  teardown, long-running scripts, and dev servers so the pool is
  released promptly and leak warnings do not fire.

Methods are arrow-function class fields, so destructuring stays
safe: `const { resetDb } = bridge; await resetDb();` works as
expected.

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
import { PGliteBridge, pushSchema } from 'prisma-pglite-bridge';

const bridge = new PGliteBridge();

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

`schemaEngine` injects an alternative schema-engine WASM module
(shape: `SchemaEngineModule`) instead of dynamically importing
`@prisma/schema-engine-wasm` — for example a build compiled from
`prisma-engines` source. When omitted, the published package is
used as before. The repo ships the build recipe:
`pnpm build:schema-engine` compiles the engine from upstream
`prisma/prisma-engines` at the exact commit matching the installed
package (override with `PRISMA_ENGINES_REF`) into
`vendor/schema-engine/`, ready to import. Requires a Rust toolchain
— the script checks and prints exact install commands for anything
missing.

## `resetSchema(adapter)`

Drops every non-system schema and recreates `public`. Useful as a
between-suite reset when you want a clean slate without re-running
all migrations.

```typescript
import { resetSchema } from 'prisma-pglite-bridge';

await resetSchema(bridge.adapter);
```

## `hasMigrations(pglite)`

Returns `true` when the `_prisma_migrations` table exists on
`pglite` and contains at least one row with
`finished_at IS NOT NULL`. Useful as a "first run" guard for
persistent `dataDir` setups so [`pushMigrations`](#pushmigrationspglite-options)
only runs on a fresh database:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { hasMigrations, pushMigrations } from 'prisma-pglite-bridge';

const pglite = new PGlite('./data/pglite');
if (!(await hasMigrations(pglite))) {
  await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
}
```

Awaits `pglite.waitReady` implicitly via `pglite.query(...)`, so it
is safe to call immediately after `new PGlite(...)`. Detects only
Prisma-managed migrations — [`pushSchema`](#pushschemaadapter-options)
does not populate `_prisma_migrations`, so this returns `false` for
adapter-applied schemas. Use [`hasSchema`](#hasschemapglite) for the
broader check.

## `hasSchema(pglite)`

Returns `true` when the `public` schema contains at least one user
table. Broader sibling of [`hasMigrations`](#hasmigrationspglite) —
fires for any DDL, regardless of whether it came from
[`pushMigrations`](#pushmigrationspglite-options),
[`pushSchema`](#pushschemaadapter-options), or hand-rolled SQL. Use
when migrations are not part of the workflow:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { PGliteBridge, hasSchema, pushSchema } from 'prisma-pglite-bridge';

const pglite = new PGlite('./data/pglite');
const bridge = new PGliteBridge({ pglite }); // caller owns pglite — bridge.close() leaves it open

if (!(await hasSchema(pglite))) {
  await pushSchema(bridge.adapter, { schema });
}
```

Awaits `pglite.waitReady` implicitly via `pglite.query(...)`. Only
the `public` schema is inspected — the internal `_pglite_snapshot`
schema used by `bridge.snapshotDb()` is excluded.

## `PgBridgePool`

Lower-level escape hatch. Subclass of `pg.Pool` where every
connection is a PGlite-backed bridge. Useful for custom Prisma
setups, other ORMs, or raw SQL — no schema management, no
`resetDb`/`snapshotDb` lifecycle.

```typescript
import { PgBridgePool } from 'prisma-pglite-bridge';
import { PrismaPg } from '@prisma/adapter-pg';

// Pool creates and owns its own in-memory PGlite:
const pool = new PgBridgePool();
const adapter = new PrismaPg(pool);
// later: await pool.end(); // closes pool + pglite (pool owns it)

// Caller-supplied PGlite — caller owns the lifecycle:
import { PGlite } from '@electric-sql/pglite';
const pglite = new PGlite();
const pool2 = new PgBridgePool({ pglite });
// later: await pool2.end(); await pglite.close();
```

The constructor takes a `PgBridgePoolOptions` (also exported)
accepting `pglite` (optional), `max`, `bridgeId`, `syncToFs`,
`timeout`, `idleTimeoutMillis` (default `0`: in-process clients are
never evicted, so their prepared-statement state survives idle gaps),
and `fastQueryPath` (default `true`: named `rowMode: 'array'` queries
with a caller-supplied `types` — the shape `@prisma/adapter-pg`
emits — run through a lean submittable that skips the Describe
round-trip on repeat executions; such queries resolve to a plain
`{ rows, fields, rowCount, command, oid }` object instead of a
`pg.Result` instance, and every other shape uses the stock pg path).
Use `pool.end()` to shut the pool down. Ownership
follows the same rule as `PGliteBridge` and `PGliteServer`: when
the pool created its own PGlite, `end()` closes it; when you
supplied one, it is left open. The instance also exposes `pglite`
and a `bridgeId` field (a unique `symbol`) for filtering events
from the [diagnostics channels](./stats.md#diagnostics-channels).

Most users should prefer [`PGliteBridge`](#pglitebridge), which
wraps this class and adds schema/reset/snapshot lifecycle.

## `PGliteServer`

Exposes a PGlite instance over TCP or a Unix domain socket so
standard PostgreSQL clients can connect. Useful for the Prisma CLI
shadow database, `psql`, and SQL GUIs.

```typescript
import { PGliteServer } from 'prisma-pglite-bridge';

const server = new PGliteServer();
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

const sessionLock = new SessionLock();
const client = new pg.Client({
  stream: () => new PGliteDuplex(pglite, { sessionLock }),
});
```

## `SessionLock`

An async mutex that serializes PGlite access across multiple
duplex streams sharing one PGlite instance. `PGliteBridge` and
`PgBridgePool` install one automatically when `max > 1`; export
it for custom multi-duplex setups built on top of `PGliteDuplex`.

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
