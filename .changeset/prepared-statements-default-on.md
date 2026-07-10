---
"prisma-pglite-bridge": minor
---

Prepared-statement caching is now on by default — each Prisma query shape is
parsed and planned once per pool client instead of on every execution (~7%
lower read p50, ~18% lower p99 in the reference benchmark). Opt out with
`preparedStatements: false`.

Caching is safe at any `max` and with any number of pools or bridges sharing
one PGlite instance: statement names are unique per pool client, so cached
statements never collide. The bridge emits
`PGliteBridgeSharedInstanceWarning` for multi-pool topologies as an advisory
(no added throughput; cross-pool transactions can interleave).

Disable it if you issue DDL mid-session that changes the result type of
an already-cached query shape (fails with "cached plan must not change
result type"; applying schema before Prisma traffic, as the setup helpers
do, is safe). See docs/troubleshooting.md.

Supporting changes:

- Pool clients are no longer evicted after 10s idle: `PgBridgePool` now
  defaults `idleTimeoutMillis` to `0` (never evict), so the statement cache
  survives idle gaps. An in-process client holds no socket or server
  resources. Configurable via the new `PgBridgePoolOptions.idleTimeoutMillis`.
- Only SELECT/INSERT/UPDATE/DELETE/WITH/MERGE/VALUES statements are named:
  DDL (e.g. from `pushSchema`) and transaction control no longer consume
  cache slots. The cache names the first 500 distinct texts per client
  (bounded and frozen, not LRU); later shapes run unnamed.
