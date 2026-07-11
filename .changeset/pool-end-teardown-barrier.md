---
"prisma-pglite-bridge": patch
---

`PgBridgePool.end()` now waits (bounded, ~10s drain limit) for every
client duplex to finish tearing down before resolving — and only then
closes a pool-owned PGlite. pg-pool's own `end()` resolves without
waiting for client teardown, so an in-flight destroy-path ROLLBACK could
previously race `pglite.close()` and spin the event loop on the dead
WASM instance.
