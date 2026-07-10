---
"prisma-pglite-bridge": patch
---

Stock-pg dispatch parity: a function passed as the first argument to `query()` is now treated as a query config (as stock pg does) instead of being consumed as a callback, and empty query text is no longer fast-path eligible — it runs through stock pg, which owns EmptyQueryResponse semantics.
