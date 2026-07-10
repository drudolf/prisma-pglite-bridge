---
"prisma-pglite-bridge": patch
---

`snapshotDb()` now rebuilds under a staging schema inside a single
transaction and swaps it into place at commit. A failed re-snapshot
previously destroyed the existing snapshot first, silently degrading
every later `resetDb()` from "restore seed" to "wipe to empty"; now
the previous snapshot stays fully restorable. `snapshotDb`, `resetDb`,
and `resetSnapshot` are also serialized against each other, so
un-awaited overlapping calls can no longer interleave their SQL.
