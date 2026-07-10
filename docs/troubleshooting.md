# Troubleshooting & limitations

## Limitations

- **Node.js 20+ only** — requires `node:stream` and `node:fs`.
  Does not work in browsers despite PGlite's browser support.
- **WASM cold start** — the first PGlite query through a
  `PGliteBridge` takes ~2s for PGlite WASM compilation. Subsequent
  calls in the same process reuse the compiled module.
- **Single PostgreSQL session** — PGlite runs in single-user mode.
  All pool connections share one session. With `max > 1`, a
  `SessionLock` serializes transactions (one at a time), but `SET`
  variables leak between connections within a single test. An open
  cursor (`pg-cursor`, `rows: N`) holds the session the same way an
  open transaction does — read or close it promptly, or other
  clients queue behind it. `resetDb()`
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

## `cached plan must not change result type`

The bridge caches Prisma queries as named prepared statements by
default. PostgreSQL revalidates those plans after
DDL, and revalidation fails with this error when the DDL changed the
*result type* of an already-cached query shape — typically
`ALTER TABLE ... ALTER COLUMN ... TYPE` on a column the query selects.
Adding tables or columns is safe, and applying schema *before* Prisma
traffic (as the setup helpers do) can never hit this.

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
(since 1.7): statement names are unique per pool client, connect-time
cleanup runs only when no other client is live, and a `DEALLOCATE` /
`DISCARD ALL` issued through any pool client evicts the affected names
from every live client's plan cache. If the error appears anyway,
avoid session-wide deallocation outside the pools, or pass
`preparedStatements: false` to the bridge.

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
