---
"prisma-pglite-bridge": minor
---

Prepared-statement caching is now on by default for `max: 1` pools (the
default configuration) — each Prisma query shape is parsed and planned once
per session instead of on every execution (~7% lower read p50, ~18% lower
p99 in the reference benchmark). Opt out with `preparedStatements: false`.

**If you run multiple live pools or bridges against one PGlite instance**,
disable it: each new pool's connect-time session cleanup deallocates the
others' cached statements, and their next cached query fails with Postgres
error 26000 ("prepared statement does not exist"). The bridge now emits
`PGliteSharedPGliteWarning` when it detects this topology, which was already
unsupported for transactions. Sequential sharing (close one bridge before
creating the next) is unaffected.

Also disable it if you issue DDL mid-session that changes the result type of
an already-cached query shape (fails with "cached plan must not change
result type"; applying schema before Prisma traffic, as the setup helpers
do, is safe). See docs/troubleshooting.md for both symptoms.

Supporting changes:

- `preparedStatements: true` combined with `max > 1` now throws a
  `TypeError` at construction (this configuration was silently broken —
  named statements prepared through different pool clients collide).
- Pool clients are no longer evicted after 10s idle: `PgBridgePool` now
  defaults `idleTimeoutMillis` to `0` (never evict), so the statement cache
  survives idle gaps. An in-process client holds no socket or server
  resources. Configurable via the new `PgBridgePoolOptions.idleTimeoutMillis`.
- Only SELECT/INSERT/UPDATE/DELETE/WITH/MERGE/VALUES statements are named:
  DDL (e.g. from `pushSchema`) and transaction control no longer consume
  cache slots. The cache names the first 500 distinct texts (bounded and
  frozen, not LRU); later shapes run unnamed.
