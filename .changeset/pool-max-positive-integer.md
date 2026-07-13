---
"prisma-pglite-bridge": patch
---

`PgBridgePool` now rejects a non-positive-integer `max` with a `TypeError`. Previously `max: 0` fell through to pg-pool's `max || 10` fallback and silently ran ten clients without a shared SessionLock — no transaction isolation on the shared PGlite session.
