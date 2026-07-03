---
"prisma-pglite-bridge": minor
---

`createBridgeTest({ scope: 'test' })` is now roughly an order of
magnitude faster. Instead of paying a full PGlite cold start +
migrations + seed on every test, it builds one template per file
(cold start + migrations + seed, paid once), dumps it, and loads a
fresh, independent PGlite instance from that template for each test.

The one behavior change: your `seed` callback now runs once per file
(against the template) instead of once per test, so any side effects
it performs — database writes and otherwise — happen once per file.
Every test still starts from the fully seeded state, stays fully
isolated, and `test.concurrent` remains safe. Each live instance
keeps its own in-memory data directory, so many concurrent tests
trade memory for isolation.
