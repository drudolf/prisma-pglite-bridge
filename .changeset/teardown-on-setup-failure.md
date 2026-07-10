---
"prisma-pglite-bridge": patch
---

No leaked WASM instances on setup failure: `createBridgeContextFromDump` now closes the bridge and the loaded PGlite instance when a client factory or bridge option validation throws (the same contract `createBridgeContext` already had), and `new PGliteBridge()` closes its self-created PGlite when the Prisma adapter constructor throws — previously the half-constructed bridge left the instance open and unclosable. Caller-supplied instances are left open, as before.
