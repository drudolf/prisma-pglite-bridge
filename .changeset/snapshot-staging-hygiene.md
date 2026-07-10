---
"prisma-pglite-bridge": patch
---

Snapshot-manager hygiene. The staging schema `_pglite_snapshot_new` (left behind only by a hard crash mid-`snapshotDb` on a persisted dataDir) is now excluded from the user-table and sequence scans, so a subsequent `resetDb` no longer truncates or captures staged data. Schema-drift error messages render column names via `quote_ident`, correctly escaping quotes in exotic column names (plain lowercase names now render unquoted).
