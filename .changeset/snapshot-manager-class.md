---
"prisma-pglite-bridge": patch
---

Internal refactor: rewrite `SnapshotManager` from a closure-based
factory (`createSnapshotManager`) into a class, matching the rest of
the codebase. Public API is unchanged.
