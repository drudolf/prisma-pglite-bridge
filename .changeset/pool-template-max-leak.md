---
"prisma-pglite-bridge": patch
---

`createPoolContext`, `setupPGlitePool`, `createPoolTest` and `loadPoolTemplate` now validate `pool.max` before creating or loading a PGlite, so an invalid `max` no longer leaks an orphaned WASM instance.
