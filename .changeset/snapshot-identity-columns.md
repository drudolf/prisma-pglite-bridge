---
"prisma-pglite-bridge": patch
---

`resetDb()` now restores snapshots of tables with `GENERATED ALWAYS AS
IDENTITY` and stored generated columns. Restores use explicit column lists
(generated columns recompute) plus `OVERRIDING SYSTEM VALUE` where an ALWAYS
identity column exists; previously such tables snapshotted fine but every
restore threw `cannot insert a non-DEFAULT value into column`. A source table
or column dropped since `snapshotDb()` now fails fast with an explicit error
before anything is truncated, instead of a raw Postgres error (or a silently
partial restore) mid-restore.
