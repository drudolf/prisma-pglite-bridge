---
'prisma-pglite-bridge': patch
---

Route every identifier interpolated into snapshot/reset SQL through
`quote_ident` (SQL side for round-tripped values, a matching JS
helper for internal constants) instead of hand-wrapping them with
double quotes. User-table identifiers were already safely quoted;
this tightens the remaining internal call sites — `_pglite_snapshot`,
`_snap_N`, and the `snap_name` column round-trip — so the snapshot
manager's SQL construction is uniform and defense-in-depth clean.
