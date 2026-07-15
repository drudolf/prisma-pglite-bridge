---
"prisma-pglite-bridge": patch
---

Honor `query_timeout` on the fast query path. A query matching the fast-path shape (named + `rowMode: 'array'` + caller-supplied `types`) previously dropped a truthy per-query timeout. The bridge now wraps both explicit and pool-default values in an outer timer without changing the fast-path result shape, and keeps successors behind the real completion after the caller times out. `query_timeout: 0`, matching pg, falls back to any pool-level default. The timeout bounds the caller's promise, not backend work: PGlite still finishes admitted statements. Because PGlite executes on the JS thread, the timer can fire only while the event loop is free, never against the query's own WASM execution.
