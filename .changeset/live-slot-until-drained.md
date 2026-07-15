---
"prisma-pglite-bridge": patch
---

Keep a pool counted toward the shared-instance overlap warning until it has actually drained. `end()` previously released the pool's slot synchronously, but pg-pool keeps checked-out clients alive until they are released — so a pool constructed on the same PGlite during that drain window missed the `PGliteBridgeSharedInstanceWarning` although real cross-pool interleaving was possible. A pool that ever held a client — or that still has an unsettled client teardown in flight — now releases its slot only after `end()`'s duplex-teardown barrier settles; a never-connected pool still releases synchronously (the constructor-failure cleanup path cannot await). The decision is latched to the first `end()` call, so repeated `end()` cannot release early.
