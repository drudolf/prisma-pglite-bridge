---
"prisma-pglite-bridge": patch
---

Internal refactor: rename `BridgeClient` to `PgBridgeClient` (and the
matching file, types, and options symbol). The class extends
`pg.Client`; the `Pg` prefix marks it as the pg-flavored variant.
The standalone `bridgeClientOptionsKey` export is now a
`PgBridgeClient.OptionsKey` static property. Public API is unchanged
— neither name was exported from the package root.
