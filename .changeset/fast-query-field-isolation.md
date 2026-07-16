---
"prisma-pglite-bridge": patch
---

Return an owned copy of `fields` from fast-path query results so caller
mutations can no longer corrupt the per-client field-metadata cache and
poison later executions of the same named statement.
