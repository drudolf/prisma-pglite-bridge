---
"prisma-pglite-bridge": minor
---

Rename the factory return type: what `createPGliteBridge()` resolves
to is now exported as `CreatePGliteBridge` (was `PGliteBridge`). The
`PGliteBridge` name is now reserved for the new class-form export.

**Migration:** rename type imports of `PGliteBridge` (the factory
return) to `CreatePGliteBridge`. Runtime behavior unchanged.
