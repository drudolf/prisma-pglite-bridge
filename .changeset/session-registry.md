---
"prisma-pglite-bridge": patch
---

Internal: collocate the per-PGlite session-scope registries (`livePoolCounts`,
`liveClientCounts`, `liveClients`) into a single `session-registry` module
instead of splitting them across the pool and client modules, and give the pool
`end()` teardown closure a clearer name. No behavior change.
