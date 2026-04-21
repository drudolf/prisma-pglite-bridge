---
'prisma-pglite-bridge': minor
---

Add opt-in stats collection
(`statsLevel: 'off' | 'basic' | 'full'`, default `'off'`).
Retrieve via `await adapter.stats()` — returns `undefined` at
`'off'`.

- `'basic'` captures timing (`durationMs`, `schemaSetupMs`),
  counters (`queryCount`, `failedQueryCount`, `resetDbCalls`),
  `dbSizeBytes`, and a sliding-window query percentile set
  (`recentP50QueryMs`, `recentP95QueryMs`, `recentMaxQueryMs`) over
  the most recent ~10,000 queries.
  Lifetime totals (`queryCount`, `totalQueryMs`, `avgQueryMs`) are
  not windowed.
- `'full'` adds `processRssPeakBytes` (process-wide, kernel-tracked
  via `process.resourceUsage().maxRSS`) and session-lock wait
  statistics.
- `Stats` is a discriminated union (`StatsBasic | StatsFull`) keyed
  on `statsLevel`. Narrow via `if (s.statsLevel === 'full')` to
  read `'full'`-only fields.
- Invalid `statsLevel` values throw at `createPgliteAdapter()` time.
- Collection is wired through `node:diagnostics_channel`: the
  bridge publishes to `QUERY_CHANNEL`
  (`prisma-pglite-bridge:query`) and `LOCK_WAIT_CHANNEL`
  (`prisma-pglite-bridge:lock-wait`), and the built-in collector
  subscribes when `statsLevel` is not `'off'`. Both channel names
  and the `QueryEvent` / `LockWaitEvent` payload types are exported
  for external consumers (OpenTelemetry, APM, custom loggers).
- `createPgliteAdapter()` and `createPool()` now return
  `adapterId: symbol` — filter published events by this id when
  multiple adapters share a process.
- `'off'` has no internal collection and no `ErrorResponse`
  buffering. The hot path stays effectively zero-cost **unless
  an external consumer subscribes** to the public diagnostics
  channels — subscribing opts in to the timing and payload cost,
  gated by `channel.hasSubscribers`.
- `close()` is re-entrant; `freeze()` seals the snapshot in a
  `finally` block so a `pg_database_size` rejection cannot leave
  subsequent `stats()` calls querying a closing PGlite.
