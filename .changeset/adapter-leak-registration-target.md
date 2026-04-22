---
'prisma-pglite-bridge': patch
---

Fix false-positive `PgliteAdapterLeakWarning` when consumers
destructure the return value of `createPgliteAdapter()` and keep only
`adapter` (e.g. via `new PrismaClient({ adapter })`). The
`FinalizationRegistry` now tracks the Prisma adapter instance itself
rather than the wrapper object returned by `createPgliteAdapter()`, so
the warning fires only when the adapter — and therefore the pool — is
genuinely unreachable.
