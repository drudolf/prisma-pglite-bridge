---
"prisma-pglite-bridge": minor
---

Rename the public type exports for the bridge:

- The factory return type — what `createPGliteBridge()` resolves to
  — is now exported as `CreatePGliteBridge` (was `PGliteBridge`).
- The class-form export is now `PGliteBridge` (was `PGliteBridgeCls`,
  which had been provisional).

**Migration:** rename type imports of `PGliteBridge` (the factory
return) to `CreatePGliteBridge`, and rename `PGliteBridgeCls` to
`PGliteBridge`. Runtime behavior unchanged.
