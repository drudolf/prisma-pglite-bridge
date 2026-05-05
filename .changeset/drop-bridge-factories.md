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

**Breaking — `pglite` is now optional and ownership is determined at
construction:** `PGliteBridge` and `PGliteServer` no longer require a
`pglite` argument. When omitted, each class creates its own in-memory
`PGlite` and owns its lifecycle — `close()` shuts it down. When you
supply a `pglite`, the class treats it as caller-owned and `close()`
leaves it open. The `{ closePglite: false }` escape hatch on `close()`
is removed; the decision is made once, at construction.

`pool.end()` is unchanged — `pg.Pool`'s inherited signature doesn't
accept options, so `PgBridgePool` users continue to call
`await pool.end(); await pglite.close()` explicitly.

**Migration:**

```ts
// before
import { createPGliteBridge, createPool } from 'prisma-pglite-bridge';
const bridge = await createPGliteBridge({ pglite });
const { pool, close } = await createPool({ pglite });

// after — no pglite needed for the common in-memory case:
import { PGliteBridge, PgBridgePool } from 'prisma-pglite-bridge';
const bridge = new PGliteBridge();            // owns its own PGlite
const pool = new PgBridgePool({ pglite });    // PgBridgePool still requires pglite
// later: await pool.end();

// after — caller-supplied PGlite (e.g. custom dataDir or extensions):
const pglite = new PGlite({ extensions: { uuid_ossp } });
const bridge = new PGliteBridge({ pglite }); // caller owns; bridge.close() leaves it open
// later: await bridge.close(); await pglite.close();
```
