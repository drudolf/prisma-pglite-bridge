---
"prisma-pglite-bridge": patch
---

Pin `@prisma/schema-engine-wasm` to the engine build shipped with Prisma
7.10.1 (`8.1.0-1.d1b3f377`), so `pushSchema` uses the same schema engine
as the `prisma` CLI of the matching release.
