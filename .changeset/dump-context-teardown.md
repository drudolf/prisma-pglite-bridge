---
"prisma-pglite-bridge": patch
---

`createBridgeContextFromDump` no longer leaks the loaded PGlite
instance when setup fails: a throwing client factory (or bridge
option validation) now closes the bridge and the loaded instance
before the setup error propagates — the same contract
`createBridgeContext` already had.
