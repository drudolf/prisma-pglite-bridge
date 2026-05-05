---
"prisma-pglite-bridge": patch
---

Internal refactor: regroup `migrations.ts` and `schema.ts` into
`src/schema/`, mirroring the `duplex/` / `pool/` / `telemetry/` /
`pglite-bridge/` folder pattern. `schema.ts` becomes
`src/schema/index.ts`. Public API is unchanged.
