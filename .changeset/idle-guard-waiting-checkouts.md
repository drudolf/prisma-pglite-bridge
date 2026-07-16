---
"prisma-pglite-bridge": patch
---

`resetDb()`, `snapshotDb()`, and `resetSnapshot()` now also throw when a
pool checkout is still WAITING for dispatch, not only when a client is
checked out. Previously an un-awaited query fired in the same tick was
invisible to the guard (pg-pool defers dispatch by one tick), so the reset
could interleave with it and the query's rows silently survived into the
"fresh" database. Awaiting all pending queries before calling remains the
documented contract — a query behind a caller-side async hop is invisible
to every pool counter.
