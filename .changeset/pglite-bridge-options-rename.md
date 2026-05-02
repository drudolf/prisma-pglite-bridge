---
"prisma-pglite-bridge": minor
---

Rename `CreatePGliteBridgeOptions` to `PGliteBridgeOptions`. The
options interface for `createPGliteBridge` now matches the
`PGliteBridge` return type — both share the `PGliteBridge` prefix.

**Migration:** rename any imports of `CreatePGliteBridgeOptions`
to `PGliteBridgeOptions`. Behavior is unchanged.
