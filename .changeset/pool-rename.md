---
"prisma-pglite-bridge": major
---

Rename `createPool`'s module and options interface:
`src/create-pool.ts` → `src/pool.ts`, `CreatePoolOptions` →
`PoolOptions`. Aligns with the `create-pglite-bridge` →
`pglite-bridge` rename.

**Migration:** rename imports of `CreatePoolOptions` to
`PoolOptions`. Behavior unchanged.
