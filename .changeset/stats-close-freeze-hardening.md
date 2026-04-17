---
'prisma-pglite-bridge': patch
---

Harden the close/freeze lifecycle for the stats collector. `close()`
is now re-entrant: concurrent calls return the same promise instead
of double-invoking `pool.end()` and `pglite.close()`. `freeze()` now
seals `dbSizeFrozen` in a `finally` block, so a rejection from
`queryDbSize` no longer leaves subsequent `stats()` calls querying a
closing PGlite. `recordQuery`, `recordLockWait`, and
`incrementResetDb` ignore post-freeze mutations instead of silently
corrupting the frozen snapshot.
