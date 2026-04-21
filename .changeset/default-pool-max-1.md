---
"prisma-pglite-bridge": patch
---

Default `max` for `createPool` / `createPgliteAdapter` is now `1` (was `5`).
PGlite runs queries serially inside its WASM runtime, so extra pool
connections added memory overhead without adding throughput. Benchmarks
show 80–99% lower RSS growth across scenarios and equal-or-better
wall-clock times. Users who previously set `max` explicitly are
unaffected — and if you had bumped `max` hoping for parallelism,
you can now drop the override and reclaim that memory. The only
reason to raise `max` above 1 is to deliberately exercise
pool wait-queue behaviour (e.g. session-lock contention tests).
