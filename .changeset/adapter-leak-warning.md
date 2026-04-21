---
'prisma-pglite-bridge': minor
---

Emit a `PgliteAdapterLeakWarning` process warning when a
`PgliteAdapter` is garbage-collected without `close()` being called.
A `FinalizationRegistry` tracks each adapter returned by
`createPgliteAdapter` and unregisters it in `close()`; adapters that
go unreachable with the registry still active surface a visible
warning instead of silently leaking the pool and its background
intervals. The check adds no hot-path overhead — it runs only when
the adapter reference is collected.
