---
"prisma-pglite-bridge": minor
---

Add `pushSchema` and `resetSchema` helpers that apply a Prisma schema to a
PGlite database in-process via `@prisma/schema-engine-wasm` — no native
schema-engine binary, no TCP. The WASM module is loaded lazily, so consumers
who only use `createPgliteAdapter` pay no init cost.
