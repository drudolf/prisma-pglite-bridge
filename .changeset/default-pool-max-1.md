---
"prisma-pglite-bridge": patch
---

Default `max` for `createPool` / `createPgliteAdapter` is now `1` (was `5`).
PGlite runs queries serially inside its WASM runtime, so extra pool
connections added memory overhead without adding throughput. Benchmarks
show 80–99% lower RSS growth across scenarios and equal-or-better
wall-clock times. Users who previously set `max` explicitly are
unaffected.
