---
"prisma-pglite-bridge": minor
---

Driver-agnostic testing helpers at `prisma-pglite-bridge/pool/vitest` and
`prisma-pglite-bridge/pool/jest`: `setupPGlitePool` (one call — pool,
schema `setup` callback, async-capable `client` factory, `seed`,
snapshot, hooks) and `createPoolTest` (vitest fixtures `{ pool, client }`
with the same `test`/`file`/`worker` scopes as `createBridgeTest`,
including template-dump isolation for `test.concurrent`). Any ORM's
migrator or raw DDL is the schema source; `dispose` runs the ORM's own
teardown before the pool closes; `resetDb`/`snapshotDb` share the
bridge's snapshot machinery and idle-pool gate (`POOL_NOT_IDLE`).
