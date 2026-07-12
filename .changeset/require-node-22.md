---
"prisma-pglite-bridge": minor
---

Require Node.js >= 22. The fast-query deferred is now built with the
standard `Promise.withResolvers()` (Node 22+, `lib` ES2024) instead of a
hand-rolled `new Promise` executor, dropping two definite-assignment
assertions. Node 20 reached end-of-life in April 2026 and is no longer
supported.
