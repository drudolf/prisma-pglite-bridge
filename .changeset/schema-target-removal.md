---
"prisma-pglite-bridge": major
---

Drop the `SchemaTarget` indirection from `pushMigrations`,
`pushSchema`, and `resetSchema`. Each function now takes the
underlying handle directly:

- `pushMigrations(pglite, options)` — was `pushMigrations(bridge, options)`
- `pushSchema(adapter, options)` — was `pushSchema(bridge, options)`
- `resetSchema(adapter)` — was `resetSchema(bridge)`

`pushMigrations` runs raw SQL through `pglite.exec`, so it now
asks for the `PGlite` instance. `pushSchema` and `resetSchema`
go through the Prisma WASM engine, so they take the `PrismaPg`
adapter directly. The wrapper that accepted either a bridge or
a raw handle is gone.

The snapshot manager now self-heals when the `_pglite_snapshot`
schema is dropped externally (e.g. during a schema reset),
removing the cross-module `resetSnapshot` carve-out previously
needed in `resetSchema`.

**Migration:**

```ts
// before
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });
await pushSchema(bridge, { schema });
await resetSchema(bridge);

// after
await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
await pushSchema(bridge.adapter, { schema });
await resetSchema(bridge.adapter);
```
