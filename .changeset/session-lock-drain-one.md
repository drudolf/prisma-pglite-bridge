---
"prisma-pglite-bridge": patch
---

Fix `SessionLock` wait queue to drain one bridge at a time instead of all at once. Prevents a race where multiple waiters bypass the lock simultaneously after a transaction completes.
