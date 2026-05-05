---
"prisma-pglite-bridge": patch
---

Internal refactor: regroup `pglite-server.ts` into
`src/pglite-server/`, completing the folder-per-class pattern.
`pglite-server.ts` becomes `src/pglite-server/index.ts`. Top-level
`src/` now holds only the public barrel plus six cohesive folders.
Public API is unchanged.
