---
"prisma-pglite-bridge": minor
---

Stats type surface: discriminated union on `statsLevel`, ring-buffer
sliding window for percentiles, clearer field names on divergent
populations, runtime validation.

- `Stats` is now `Stats1 | Stats2` discriminated by `statsLevel`.
  Narrow via `if (s.statsLevel === 2)` to access level-2 fields.
- Query-percentile fields renamed to signal their windowed population:
  `p50QueryMs` → `recentP50QueryMs`, `p95QueryMs` → `recentP95QueryMs`,
  `maxQueryMs` → `recentMaxQueryMs`. `queryCount`, `totalQueryMs`,
  `avgQueryMs` remain lifetime-scoped.
- Level-2 peak RSS renamed: `processPeakRssBytes` → `processRssPeakBytes`.
- Percentile data is now retained via a ring buffer trimmed to
  `QUERY_DURATION_WINDOW_SIZE` (10,000) — amortized O(1) on every
  `recordQuery`. Exported as a named constant.
- Out-of-range `statsLevel` values (<0, >2) now throw at
  `createPgliteAdapter()` time instead of silently misbehaving.
