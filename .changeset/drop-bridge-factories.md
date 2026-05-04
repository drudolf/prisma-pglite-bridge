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

- `PGliteBridgeOptions` / `CreatePGliteBridgeOptions` → `PGliteBridgeConfig`
- `CreatePGliteBridge` (factory return type) → `PGliteBridge` (the class itself)
- `CreatePoolOptions` / `PoolOptions` → `PgBridgePoolConfig`

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
