---
"prisma-pglite-bridge": patch
---

Match pg's `uncaughtException` channel when an asynchronous query callback throws, instead of surfacing an unhandled promise rejection.
