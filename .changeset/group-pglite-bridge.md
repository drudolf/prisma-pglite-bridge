---
"prisma-pglite-bridge": patch
---

Internal refactor: move `PGliteBridge` and its private snapshot helper
into `src/pglite-bridge/`, mirroring the `duplex/`, `pool/`, and
`telemetry/` folders. `src/utils/` now holds only true cross-cutting
helpers. Public API is unchanged. Test descriptions drop the leftover
`(class)` qualifier now that the bridge has only a class-based form.
