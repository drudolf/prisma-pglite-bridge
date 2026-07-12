---
"prisma-pglite-bridge": patch
---

Internal: remove the three reducible `as`-casts from the test helpers.
`createBridgeContext` narrows `schema` with a guard instead of casting
to `PushSchemaOptions`; the vitest fixtures read the client through a
`takeClient` guard (shared by both fixtures) instead of asserting
`clients.get(bridge) as TClient`. The one remaining cast — the
invariant-`TestAPI` narrowing that hides the internal `template`
fixture in `'test'` scope — is documented as irreducible and pinned by
a new `expectTypeOf` test on the public fixture surface. No behavior
change.
