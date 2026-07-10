---
"prisma-pglite-bridge": patch
---

Remove `sessionLock` and `protocolCleanupNeeded` from `PgBridgePoolOptions`. Both were accepted by the type but silently ignored — the pool always builds its own `SessionLock` and detects protocol-cleanup capability itself. Passing them is now a compile-time error.
