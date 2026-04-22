---
'prisma-pglite-bridge': patch
---

Perf: `BackendMessageFramer` now coalesces contiguous complete backend
messages that arrive in the same PGlite chunk and forwards them as a
single downstream slice. This reduces per-message `push()`/`onMessage`
churn on read-heavy queries without changing wire bytes or the
cross-chunk streaming path.
