---
"prisma-pglite-bridge": patch
---

Roll back a transaction left open when a pool client is plain-released
(no COMMIT/ROLLBACK). Because pool clients share one PGlite session, an
abandoned open transaction previously kept the session lock owned —
wedging every other pool client indefinitely — and leaked the open
transaction into the recycled client's next checkout. It is now rolled
back at release time, unblocking waiters and giving the next checkout a
clean session, and a `PGliteBridgeAbandonedTransactionWarning` is emitted
so the application bug (a missing COMMIT/ROLLBACK) is diagnosable.
