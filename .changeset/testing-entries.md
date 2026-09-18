---
"prisma-pglite-bridge": minor
---

Two new entry points expose the runner-agnostic core under the test
helpers. `prisma-pglite-bridge/testing` exports `createBridgeContext`,
`createBridgeTemplate`, `loadBridgeTemplate` and the types
`BridgeContext`, `BridgeContextOptions`, `BridgeTemplate`,
`BridgeTemplateOptions`, `LoadBridgeTemplateOptions`,
`TemplateCompression`; `prisma-pglite-bridge/pool/testing` exports the
Prisma-free twins `createPoolContext`, `createPoolTemplate`,
`loadPoolTemplate` and `PoolTemplate`, `PoolContextOptions`,
`PoolTemplateOptions`, `LoadPoolTemplateOptions`,
`PGlitePoolTestContext`, `TemplateCompression`. `createBridgeContext`
validates the schema source itself (exactly one of `migrations` /
`schema`, a `TypeError` before any PGlite exists) and returns `close()`,
which ends the pool and closes the PGlite only when the context created
it — never `prisma.$disconnect()`. The template builders and loaders
reject a `pglite` option with a `TypeError`; `compression: 'none' |
'gzip'` (default `'none'`) is set on both the builder and the loader,
and the loader applies the matching MIME type so a template read back
from a file loads as is. A load PGlite rejects throws the new
`TEMPLATE_LOAD_FAILED` with PGlite's error as `cause`. A loaded context
holds no snapshot, so `resetDb()` truncates it to empty. `createBridgeTest`
and `createPoolTest` with `scope: 'test'` now reject a supplied
`bridge.pglite` / `pool.pglite` with a `TypeError` at the call.
