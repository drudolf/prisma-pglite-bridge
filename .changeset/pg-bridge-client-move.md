---
"prisma-pglite-bridge": patch
---

Internal refactor: move `PgBridgeClient` from `src/` into
`src/utils/`, alongside the related primitives (`bridge-stats`,
`session-lock`). Public API is unchanged.
