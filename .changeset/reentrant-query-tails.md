---
"prisma-pglite-bridge": patch
---

Preserve the submission chain when stock pg submission synchronously
re-enters `query()` (a `toPostgres` hook or a warm fast-path type parser):
the nested query's tail is no longer stomped by the outer query, so chained
ordering and release-time abandoned-transaction cleanup see the in-flight
work.
