---
"prisma-pglite-bridge": minor
---

# Add snapshotDb/resetSnapshot for fast test isolation

`snapshotDb()` captures the current database state into a shadow schema.
Subsequent `resetDb()` calls restore from the snapshot instead of
truncating to empty, avoiding expensive re-seeding through the Prisma
wire protocol.

Also fixes sequence save/restore: `quote_ident` was producing bare
identifiers that PostgreSQL interpreted as column references; switched
to `quote_literal` and added a `last_value IS NOT NULL` filter for
never-called sequences.
