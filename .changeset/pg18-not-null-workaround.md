---
"prisma-pglite-bridge": patch
---

Shield the schema engine from PostgreSQL 18's `contype = 'n'` rows during
`pushSchema`. PostgreSQL 18 represents NOT NULL constraints as `pg_constraint`
rows, which the Prisma schema engine's constraint introspection does not
handle and panics on — the `pushSchema` promise then never settles. The bridge
now appends `'n'` to the engine's introspection denylist before the query
runs; a semantic no-op on PostgreSQL ≤ 17. This unblocks running against
PGlite 0.5.x (PostgreSQL 18.3).
