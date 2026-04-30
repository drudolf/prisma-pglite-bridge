---
"prisma-pglite-bridge": minor
---

Rename the public surface to better reflect what each piece returns.

The factory function and its return type now use `Bridge` (since the
returned bundle holds the Prisma adapter, the underlying PGlite
instance, and lifecycle helpers — not just an adapter), while the
underlying `Duplex` stream that replaces `pg.Client`'s socket is now
named `Duplex`. Casing matches `@electric-sql/pglite`'s `PGlite`.

Renames:

- `createPgliteAdapter` → `createPGliteBridge`
- `CreatePgliteAdapterOptions` → `CreatePGliteBridgeOptions`
- `PgliteAdapter` (returned type) → `PGliteBridge`
- `PGliteBridge` (Duplex stream class) → `PGliteDuplex`
- `PgliteAdapterLeakWarning` (process warning type) → `PGliteBridgeLeakWarning`
- `emitAdapterLeakWarning` (internal) → `emitBridgeLeakWarning`

Migration:

```diff
- import { createPgliteAdapter, PGliteBridge } from 'prisma-pglite-bridge';
+ import { createPGliteBridge, PGliteDuplex } from 'prisma-pglite-bridge';

- const pgliteAdapter = await createPgliteAdapter({ pglite });
+ const bridge = await createPGliteBridge({ pglite });
- const prisma = new PrismaClient({ adapter: pgliteAdapter.adapter });
+ const prisma = new PrismaClient({ adapter: bridge.adapter });
```
