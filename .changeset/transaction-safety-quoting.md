---
"prisma-pglite-bridge": patch
---

Harden transaction safety in `writeSentinel` and migration application with proper ROLLBACK on failure. Fix snapshot identifier quoting — store raw schema/table names and apply `quote_ident` only on retrieval, preventing double-quoting. Move sequence restore inside the `session_replication_role` try block.
