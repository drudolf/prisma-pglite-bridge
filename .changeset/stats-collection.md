---
'prisma-pglite-bridge': minor
---

Add opt-in stats collection (`statsLevel: 0 | 1 | 2`, default `0`).
Retrieve via `await adapter.stats()` — returns `null` at level 0.

- Level 1 captures timing (`durationMs`, `wasmInitMs`,
  `schemaSetupMs`), counters (`queryCount`, `failedQueryCount`,
  `resetDbCalls`), `dbSizeBytes`, and a sliding-window query
  percentile set (`recentP50QueryMs`, `recentP95QueryMs`,
  `recentMaxQueryMs`) over the most recent
  `QUERY_DURATION_WINDOW_SIZE` (10,000) queries. Lifetime totals
  (`queryCount`, `totalQueryMs`, `avgQueryMs`) are not windowed.
- Level 2 adds `processRssPeakBytes` (process-wide, sampled) and
  session-lock wait statistics.
- `Stats` is a discriminated union (`Stats1 | Stats2`) keyed on
  `statsLevel`. Narrow via `if (s.statsLevel === 2)` to read
  level-2 fields.
- Out-of-range `statsLevel` values throw at
  `createPgliteAdapter()` time.
- Level 0 has zero hot-path overhead — no `hrtime` reads, no
  bookkeeping, no `ErrorResponse` buffering.
- `close()` is re-entrant; `freeze()` seals the snapshot in a
  `finally` block so a `pg_database_size` rejection cannot leave
  subsequent `stats()` calls querying a closing PGlite.
