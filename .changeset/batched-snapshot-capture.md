---
"prisma-pglite-bridge": patch
---

Build snapshot table metadata directly in SQL and batch table copies into one
protocol call. Snapshot creation now uses a bounded number of PGlite API calls
regardless of table count, while retaining atomic replacement, identifier
quoting, and compatibility with the existing snapshot layout.
