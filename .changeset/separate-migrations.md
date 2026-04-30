---
"prisma-pglite-bridge": minor
---

Split migration application out of `createPGliteBridge` into a new
`pushMigrations(target, options)` helper, sibling to `pushSchema`.

`createPGliteBridge` no longer accepts `sql`, `migrationsPath`, or
`configRoot` — call `pushMigrations` on the returned bridge instead.
The new helper avoids loading `@prisma/schema-engine-wasm`, so projects
that only replay pre-generated migrations no longer trigger Node's
`ExperimentalWarning: Importing WebAssembly module instances`.

The returned `PGliteBridge` now exposes the underlying `pglite`
instance for symmetry with `pushSchema` / `pushMigrations`.

Breaking changes:

- `createPGliteBridge({ sql | migrationsPath | configRoot })` is no
  longer supported. Migrate by chaining a `pushMigrations(bridge, {
  ... })` call after `createPGliteBridge`.
- `Stats.schemaSetupMs` has been removed. `pushMigrations` returns
  `{ durationMs }` for callers who want to record the cost.
