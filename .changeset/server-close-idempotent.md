---
"prisma-pglite-bridge": patch
---

`PGliteServer.close()` is now idempotent: repeat calls return the same
promise, closing a server that never listened resolves cleanly, and a
close racing an in-flight `listen()` waits the bind out instead of
leaking the listener. `listen()` on a closed server now throws instead
of returning the stale URL; a failed bind stays retryable.
