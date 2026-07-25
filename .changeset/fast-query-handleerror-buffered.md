---
"prisma-pglite-bridge": patch
---

`FastQuery.handleError` now prefers a buffered first error (row-parser
throw, bind serialization failure, PortalSuspended sentinel) over the
incoming fatal connection error as the promise rejection reason,
matching stock pg's `_canceledDueToError` handling and
`handleReadyForQuery`'s own settlement. Previously a connection dying
after a buffered type-parser failure reported the socket teardown
instead of the root cause. Found by the new fast-path property suite's
stock-Query differential. Connection teardown and pool eviction are
unaffected — pg.Client records connection-error state before the query
handler runs.
