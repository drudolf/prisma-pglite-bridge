---
"prisma-pglite-bridge": patch
---

Preserve a configured `query_timeout` default when stock pg submission synchronously re-enters `PgBridgeClient.query()`. The bridge still suppresses pg's duplicate timer while admitting the outer query, but nested promise, callback, and fast-query calls now inherit the live public default instead of silently running without a timeout.
