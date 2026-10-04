---
"prisma-pglite-bridge": patch
---

`PgBridgePoolOptions` no longer exposes the internal `onTeardownCreated` hook, which the pool ignored.
