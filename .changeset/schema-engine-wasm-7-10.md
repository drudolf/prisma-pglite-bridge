---
"prisma-pglite-bridge": patch
---

Pin `@prisma/schema-engine-wasm` to the engine build shipped with Prisma
7.10.0 (`7.10.0-4.0edf323e`), so `pushSchema` uses the same schema engine
as the `prisma` CLI of the matching release.
