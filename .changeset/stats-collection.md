---
'prisma-pglite-bridge': minor
---

Add opt-in stats collection (`statsLevel: 0 | 1 | 2`). Level 1 captures
timing (`durationMs`, `wasmInitMs`, `schemaSetupMs`), query
percentiles, counters (`queryCount`, `failedQueryCount`,
`resetDbCalls`), and `dbSizeBytes`. Level 2 adds
`processPeakRssBytes` and session-lock wait statistics. Default is 0
(off, zero overhead). Retrieve via `await adapter.stats()`.
