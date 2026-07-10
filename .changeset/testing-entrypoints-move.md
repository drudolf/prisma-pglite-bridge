---
"prisma-pglite-bridge": patch
---

Internal reorganization: the `vitest` and `jest` entry points moved from
`src/vitest/index.ts` and `src/jest/index.ts` to `src/testing/vitest.ts`
and `src/testing/jest.ts`, next to the runner-agnostic core they share.
The published subpaths `prisma-pglite-bridge/vitest` and
`prisma-pglite-bridge/jest` are unchanged.
