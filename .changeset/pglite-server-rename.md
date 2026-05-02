---
"prisma-pglite-bridge": minor
---

Rename `createPGliteServer`'s module and options interface:
`src/create-pglite-server.ts` → `src/pglite-server.ts`,
`CreatePGliteServerOptions` → `PGliteServerOptions`. Aligns with
the `create-pglite-bridge` → `pglite-bridge` and `create-pool` →
`pool` renames.

**Migration:** rename imports of `CreatePGliteServerOptions` to
`PGliteServerOptions`. Behavior unchanged.
