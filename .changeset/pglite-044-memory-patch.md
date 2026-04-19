---
'prisma-pglite-bridge': patch
---

Ship an optional `patches/@electric-sql__pglite@0.4.4.patch` in the
published package. `@electric-sql/pglite@0.4.4` retains parsed raw
protocol messages across `execProtocolRaw()` /
`execProtocolRawStream()` calls, which inflates memory on the bridge
hot path. The patch is opt-in via `pnpm.patchedDependencies` —
runtime behaviour is unchanged unless consumers apply it. See the
README for instructions.
