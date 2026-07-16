---
"prisma-pglite-bridge": patch
---

`PgBridgePool.end()` now clears its internal teardown-drain timer once the
drain completes, so a settled pool no longer leaves a stale 10-second timer
pending.
