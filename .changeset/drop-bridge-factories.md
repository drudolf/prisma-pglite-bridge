---
"prisma-pglite-bridge": minor
---

**Breaking:** Drop the `createPGliteBridge()` and `createPool()`
factory functions. The bridge and pool are now class exports
constructed directly:

- `createPGliteBridge(options)` → `new PGliteBridge(options)`
- `createPool(options)` → `new PgBridgePool(options)`

The class constructors are synchronous; PGlite readiness is awaited
internally on the first operation. `PgBridgePool` extends `pg.Pool`
directly, so its return is the pool itself — not a `{ pool, close,
bridgeId }` wrapper. Use `pool.end()` to shut it down and read
`pool.bridgeId` for diagnostics filtering.

The accompanying option/return-type names also collapse:

- `CreatePGliteBridge` (factory return type) → `PGliteBridge` (the class itself)
- `CreatePoolOptions` / `PoolOptions` → `PgBridgePoolOptions`

Also exposes `PGliteDuplexOptions` from the package barrel so all
public input bags (`PGliteBridgeOptions`, `PgBridgePoolOptions`,
`PGliteServerOptions`, `PGliteDuplexOptions`, `PushSchemaOptions`,
`PushMigrationsOptions`) follow the same `*Options` convention.

**Breaking — close lifecycle:** `bridge.close()` and `server.close()`
now also close the underlying PGlite instance by default, matching
the dominant test/script use case where the bridge or server owns
the pglite for the duration of its lifetime. Pass
`{ closePglite: false }` to opt out (e.g., when one PGlite is shared
between multiple bridges, or held by external code that should keep
running). `pool.end()` is unchanged — `pg.Pool`'s inherited signature
doesn't accept options, so `PgBridgePool` users continue to call
`await pool.end(); await pglite.close()` explicitly.

**Migration:**

```ts
// before
import { createPGliteBridge, createPool } from 'prisma-pglite-bridge';
const bridge = await createPGliteBridge({ pglite });
const { pool, close } = await createPool({ pglite });

// after
import { PGliteBridge, PgBridgePool } from 'prisma-pglite-bridge';
const bridge = new PGliteBridge({ pglite });
const pool = new PgBridgePool({ pglite });
// later: await pool.end();
```
