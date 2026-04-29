---
"prisma-pglite-bridge": patch
---

Rewrite RowDescription frames to widen `"char"` (oid 18) → `text` (oid 25)
so the official `@prisma/adapter-pg` can decode `pg_catalog` system columns
(e.g. `pg_constraint.contype`). This unblocks running the WASM schema engine
(`@prisma/schema-engine-wasm`) against the bridge — i.e. an in-process
`prisma db push` path without TCP or a Prisma-version-coupled adapter.
