---
"prisma-pglite-bridge": patch
---

Throw with an actionable message when `bridge.snapshotDb()`,
`bridge.resetDb()`, or `bridge.resetSnapshot()` is called while pool
clients are still checked out. These operations run raw SQL on the
PGlite instance bypassing the pool, so concurrent pool traffic could
silently corrupt state or deadlock — the guard surfaces the misuse
loudly. Working code that calls them outside Prisma traffic
(`beforeAll`, between tests, before `$disconnect`) is unaffected.
