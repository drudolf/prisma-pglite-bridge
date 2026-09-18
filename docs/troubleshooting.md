# Troubleshooting & limitations

Every `PgBridgeError` and bridge warning message ends with a pointer into
this file (`(docs: prisma-pglite-bridge/docs/troubleshooting.md#<code>)`);
the anchor is the error code or warning name, lowercased.

## Limitations

- **Node.js 22+ only** — requires `node:stream`, `node:fs`, and
  `Promise.withResolvers` (the binding floor; matches the package's
  `engines` field). Does not work in browsers despite PGlite's
  browser support.
- **WASM cold start** — the first PGlite query through a
  `PGliteBridge` takes ~2s for PGlite WASM compilation. Subsequent
  calls in the same process reuse the compiled module.
- **Single PostgreSQL session** — PGlite runs in single-user mode.
  All pool connections share one session. With `max > 1`, a
  `SessionLock` serializes clients' operations in admission order —
  ownership is taken when an operation is admitted and released at
  its idle ReadyForQuery, so a transaction holds the session from
  BEGIN to COMMIT/ROLLBACK — but `SET` variables still leak between
  connections within a single test. An open cursor (`pg-cursor`,
  `rows: N`) holds the session the same way an open transaction
  does — read or close it promptly, or other clients queue behind
  it. Releasing a client with an open cursor or transaction now
  recovers the session (the bridge manufactures the terminating
  Sync and rolls back an abandoned transaction; the client stays
  usable when recycled) — but recovery is a repair path, not a
  pattern. `resetDb()`
  clears more of this between tests (everything `DISCARD ALL`
  covers except named prepared statements, which are kept so the
  statement cache stays warm). The default
  `max: 1` avoids extra bridge connections and session-lock overhead.
- **Schema source required** — pick one of
  [`pushMigrations`](./api.md#pushmigrationspglite-options) (run
  `prisma migrate dev` first or pass `sql` directly) or
  [`pushSchema`](./api.md#pushschemaadapter-options) (apply
  `schema.prisma` directly). `new PGliteBridge(...)` alone wraps
  an empty database.

## `this.pglite.execProtocolRawStream is not a function`

The bridge uses the streaming protocol API introduced in PGlite 0.4
(also present in 0.5). Some packages in the Prisma ecosystem (e.g.
`@prisma/dev`) still pin `@electric-sql/pglite` to 0.3.x, which pnpm
will install alongside the newer copy — and the bridge can end up
with the older one.

Check your tree:

```sh
pnpm why @electric-sql/pglite
```

If you see more than one version, force a single supported version
(0.4.x or 0.5.x) via
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

## `Unsupported pg internals`

The pool bridge uses a small, centralized set of undocumented `pg` 8.x
internals. Each pool client validates that set during construction, before it
is registered or handles a query. If the installed `pg` copy has an
incompatible shape, construction fails once with a deterministic list of all
missing members instead of failing later in query or cleanup code.

First check which copies are installed:

```sh
pnpm why pg
```

Make sure your application, `prisma-pglite-bridge`, and
`@prisma/adapter-pg` resolve to one compatible `pg` 8.x installation. Remove
unnecessary direct pins and run `pnpm dedupe` (or your package manager's
equivalent), then reinstall.

`pg` 8.16.3 is the oldest verified-compatible release: the construction
check accepts both the `pg` <= 8.16 internal layout (plain `activeQuery`,
own `queryQueue`) and the >= 8.17 layout (`_getActiveQuery()`). On an older
8.x minor this error is a version floor, not a duplicate installation —
upgrade `pg` instead of deduplicating.

If the error started after a `pg` upgrade even with one copy installed,
return to the previously working 8.x release and report the listed members;
the private seam must be revalidated before that release can be supported.

## `cached plan must not change result type`

The bridge caches queries as named prepared statements by default —
Prisma traffic, and any object-form or parameterized string-form query
issued through the pool (ORMs like Drizzle, Kysely, TypeORM, or
MikroORM on the bridge take these paths too). PostgreSQL revalidates
those plans after DDL, and revalidation fails with this error when the
DDL changed the *result type* of an already-cached query shape —
typically `ALTER TABLE ... ALTER COLUMN ... TYPE` on a column the
query selects. Adding tables or columns is safe, and applying schema
*before* query traffic (as the setup helpers do) can never hit this.

Fix one of:

- Recreate the bridge (or `PrismaClient`) after mid-session DDL — the
  usual flow anyway for schema iteration against an in-memory database.
- Pass `preparedStatements: false` to the bridge.

## `prepared statement "ppb_..." does not exist` (error 26000)

Something outside the bridge's pools deallocated statements on the
shared session — e.g. raw `DEALLOCATE ALL` / `DISCARD ALL` issued
directly through `pglite.exec(...)`, or a hand-rolled `pg.Client` on a
`PGliteDuplex` running its own connect-time cleanup while a bridge's
cache was live.

Concurrent pools/bridges on one PGlite instance do not cause this
persistently (since 1.7): statement names are unique per pool client,
connect-time cleanup runs only when no other client is live, and a
`DEALLOCATE` / `DISCARD ALL` issued through any pool client evicts the
affected names from every live client's plan cache once it completes.
One transient race is accepted: a sibling's warm query already in
flight when that `DEALLOCATE`/`DISCARD ALL` lands can fail with a
single clean 26000 — eviction runs when the deallocation resolves, so
the next execution re-Parses and succeeds. A 26000 that *recurs*
points outside the pools: avoid session-wide deallocation outside
them, or pass `preparedStatements: false` to the bridge.

*User-named* statements can also hit 26000 when a `DEALLOCATE`
arrives in a form the bridge's bounded eviction decoder deliberately
does not parse — inside comments or multi-statement text, via
`U&"..."` syntax, or through a long-name spelling that differs from
the one used to prepare. (A quoted target adjacent to `DEALLOCATE` or
`PREPARE`, e.g. `DEALLOCATE"name"`, *is* parsed.) In every such miss
the server still deallocates the statement while the local cache stays
stale — fail-closed only against *false* eviction, not harmless — so
the affected name persistently fails 26000 on its next use until it is
re-prepared or the session resets. See the eviction-detection notes in
[api.md](./api.md#pgbridgepool) for the exact supported subset.

## Error codes

Every `PgBridgeError` message ends with a pointer into this file
(`(docs: prisma-pglite-bridge/docs/troubleshooting.md#<code>)`), and the
error carries the same pointer as its `docs` property. Match on
`error.code`; the sections below are keyed by code.

### `UNSUPPORTED_PG_INTERNALS`

See [Unsupported pg internals](#unsupported-pg-internals) above: the
installed `pg` copy lacks the private 8.x members the bridge drives.
Check `pnpm why pg`, deduplicate, and stay on `pg` ≥ 8.16.3.

### `BRIDGE_OPTIONS_REQUIRED`

`PgBridgeClient` was constructed without the pool's internal options.
If you did not construct `PgBridgeClient` yourself, two copies of `pg`
are installed and `@prisma/adapter-pg` resolves a different copy than
`prisma-pglite-bridge` extends. The adapter tests the pool with
`instanceof pg.Pool`; against a foreign copy that fails, so it treats
the bridge pool as a plain config object, and `pg-pool` then constructs
a `PgBridgeClient` from that object without the bridge options.

Diagnose:

```sh
pnpm why pg    # or: npm ls pg
```

Fix by deduplicating `pg` to one version workspace-wide — remove direct
pins that differ from `@prisma/adapter-pg`'s range, or add an override
(pnpm: `pnpm.overrides` / `pnpm-workspace.yaml` `overrides`; npm:
`overrides`). Reproduced 2026-09-18 with two `pg` copies
(`scripts/dup-pg-fixture.sh` rebuilds that scenario); two copies of
the bridge over one `pg` were tested the same day and do not trigger
it.

### `POOL_NOT_IDLE`

`resetDb()`, `snapshotDb()`, or `resetSnapshot()` was called while a
pool client was checked out or a checkout was waiting. These methods run
raw SQL on the shared session and would interleave with in-flight
queries. Await every pending query, end any open `$transaction` (or
release checked-out clients on the pool path), then call again. With
`createBridgeTest`, take `prisma` from the fixture and let the helper
reset between tests.

### `INVALID_STATS_LEVEL`

`new PGliteBridge({ statsLevel })` accepts only `'off'`, `'basic'`, or
`'full'`. See [stats](./stats.md).

### `SERVER_CLOSED`

`PGliteServer.listen()` was called after `close()`. A server is
single-use — create a new instance.

### `SERVER_PGLITE_CLOSED`

The `PGlite` instance handed to `PGliteServer` (or reused by it) is
already closed. Pass an open instance, or let the server create its own
by omitting `pglite`.

### `PGLITE_CLOSED`

A bridge, pool, or server operation started after its `PGlite` instance
was closed. Surfaces through connection or query rejection. Close the
bridge before the instance (`bridge.close()` closes an owned instance
for you), and do not share one instance across tests that close it.

### `PGLITE_NOT_READY`

`PGlite` failed to become ready, or the `timeout` option elapsed while
waiting for it. The original reason follows the colon in the message
(WASM startup failure, a corrupt `dataDir`, a template that does not
load). Check the `dataDir`, raise `timeout`, or delete a corrupt data
directory.

### `MIGRATIONS_UNAVAILABLE`

`pushMigrations` found no migration source: no `sql`, no `migration.sql`
under `migrationsPath`, or no loadable `prisma.config.ts` (from
`configRoot` or the working directory). Run `prisma migrate dev` to
generate migration files, pass `migrationsPath` explicitly, or pass
pre-generated SQL via `sql`. In monorepos set `configRoot` to the
package that owns `prisma.config.ts`.

### `MIGRATIONS_APPLY_FAILED`

The schema SQL failed inside PGlite; the PGlite error is attached as
`cause`. Common causes: the schema was already applied to a persistent
`dataDir` (guard with `hasSchema`), a migration relies on an extension
PGlite does not bundle, or the SQL was hand-edited. Fix the SQL or the
guard and re-run.

### `SNAPSHOT_INVALID`

`resetDb()` found that a table or column captured by `snapshotDb()` no
longer exists — the schema changed after the snapshot. Re-run
`snapshotDb()` after any DDL, or call `resetSnapshot()` to go back to
truncate-to-empty resets.

## Warnings

Bridge warnings go through `process.emitWarning` with a `type` from the
list below and end with the same docs pointer as errors. Filter with
`process.on('warning', (w) => w.name === '<type>')`.

### `PGliteBridgeAbandonedTransactionWarning`

A pool client was released back to the pool with an open transaction —
`release()` was called after `BEGIN` without a `COMMIT` or `ROLLBACK`.
On the shared PGlite session an open transaction would block every
other pool client and leak into the client's next checkout, so the
pool emits this warning once and rolls the transaction back
automatically before the client is reused; siblings unblock on their
own. The warning also fires when the release happened while a query
was still in flight — cleanup waits for that query to settle first
(an unawaited `COMMIT` that completes produces no warning and no
rollback).

Fix the caller: `COMMIT` or `ROLLBACK` (or let your ORM's transaction
helper finish) before releasing the client. The automatic rollback is
a safety net, not a transaction API.

### `PGliteBridgeSharedInstanceWarning`

More than one live `PgBridgePool` (or `PGliteBridge`) shares one
`PGlite` instance. Emitted once, as an advisory: all pools serialize
through the single PGlite session, so extra pools add no throughput,
and transactions from different pools can interleave unless you await
one pool's transaction before starting another's. Statement caches
coordinate across pools automatically. Expected and harmless when a
test deliberately runs raw SQL through a second pool; otherwise reuse
one pool.

### `PGliteBridgeLeakWarning`

A `PGliteBridge` was garbage-collected before `close()` was called. The
pool and its PGlite instance were released by the collector, but
`stats()` was never finalized and teardown order was not yours. Call
`bridge.close()` in `afterAll` (the testing helpers do this for you).

## `ExperimentalWarning: Importing WebAssembly module instances is an experimental feature`

Emitted by Node when `pushSchema` / `resetSchema` loads
`@prisma/schema-engine-wasm`, which uses ESM static `.wasm`
imports. The warning is harmless and prints once per Node process.

If you only need to apply already-generated migration SQL, use
[`pushMigrations`](./api.md#pushmigrationspglite-options) instead — it does
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
