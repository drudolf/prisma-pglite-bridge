---
"prisma-pglite-bridge": minor
---

Split migration application out of `createPgliteAdapter` into a new
`pushMigrations(target, options)` helper, sibling to `pushSchema`.

`createPgliteAdapter` no longer accepts `sql`, `migrationsPath`, or
`configRoot` — call `pushMigrations` on the returned adapter instead.
The new helper avoids loading `@prisma/schema-engine-wasm`, so projects
that only replay pre-generated migrations no longer trigger Node's
`ExperimentalWarning: Importing WebAssembly module instances`.

The returned `PgliteAdapter` now exposes the underlying `pglite`
instance for symmetry with `pushSchema` / `pushMigrations`.

Breaking changes:

- `createPgliteAdapter({ sql | migrationsPath | configRoot })` is no
  longer supported. Migrate by chaining a `pushMigrations(adapter, {
  ... })` call after `createPgliteAdapter`.
- `Stats.schemaSetupMs` has been removed. `pushMigrations` returns
  `{ durationMs }` for callers who want to record the cost.
