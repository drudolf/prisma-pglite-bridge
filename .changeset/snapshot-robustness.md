---
"prisma-pglite-bridge": patch
---

Snapshot and `resetDb()` robustness:

- `snapshotDb()` now rebuilds under a staging schema inside a single transaction and swaps it into place at commit. A failed re-snapshot previously destroyed the existing snapshot first, silently degrading every later `resetDb()` from "restore seed" to "wipe to empty"; now the previous snapshot stays fully restorable. `snapshotDb`, `resetDb`, and `resetSnapshot` are also serialized against each other, so un-awaited overlapping calls can no longer interleave their SQL.
- `resetDb()` now restores snapshots of tables with `GENERATED ALWAYS AS IDENTITY` and stored generated columns — explicit column lists (generated columns recompute) plus `OVERRIDING SYSTEM VALUE` where needed; previously such tables snapshotted fine but every restore threw. A source table or column dropped since `snapshotDb()` fails fast with an explicit error before anything is truncated, instead of a raw Postgres error (or a silently partial restore) mid-restore; column names in drift errors render via `quote_ident`.
- The staging schema `_pglite_snapshot_new` (left behind only by a hard crash mid-rebuild on a persisted dataDir) is excluded from the user-table and sequence scans, so a subsequent `resetDb` neither truncates nor captures staged data.
