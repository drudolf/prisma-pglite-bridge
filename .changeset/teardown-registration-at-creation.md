---
"prisma-pglite-bridge": patch
---

`PgBridgePool.end()` now waits for the duplex teardown of clients whose
connect failed before pg-pool's `'connect'` event (checkout or readiness
timeouts): teardown handles register at duplex creation inside the client
constructor instead of on `'connect'`, so no destroy-path work can outlive
the pool's close barrier.
