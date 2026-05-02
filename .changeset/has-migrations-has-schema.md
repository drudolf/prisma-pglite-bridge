---
"prisma-pglite-bridge": minor
---

Add `hasMigrations(pglite)` and `hasSchema(pglite)` introspection
helpers and expose `PGliteServer#pglite` as a public readonly field.

`hasMigrations` returns `true` when `_prisma_migrations` exists
and has at least one row with `finished_at IS NOT NULL`.
`hasSchema` returns `true` when the `public` schema contains at
least one user table — broader, fires for `pushSchema` and
hand-rolled DDL too. Both await `pglite.waitReady` implicitly via
`pglite.query(...)`, so they can be called immediately after
`new PGlite(...)`.

`PGliteServer` now exposes the supplied `pglite` as `server.pglite`
(matching `bridge.pglite` on `PGliteBridge`). `listen()` also waits
for `pglite.waitReady` internally instead of requiring callers to
await it first, and surfaces the underlying rejection on failure.

Useful as a "first run" guard for persistent `dataDir` setups:

```ts
const server = new PGliteServer({ pglite: new PGlite('./data/pglite') });
if (!(await hasMigrations(server.pglite))) {
  await pushMigrations(server.pglite, { migrationsPath: './prisma/migrations' });
}
await server.listen();
```
