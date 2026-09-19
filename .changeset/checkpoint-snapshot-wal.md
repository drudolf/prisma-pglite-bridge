---
"prisma-pglite-bridge": patch
---

Periodically checkpoint PGlite before snapshot/reset operations after 64 MiB
of WAL progress. This reclaims log files that otherwise accumulate in memory
during long test runs. The probe shares existing database calls and leaves
callers without checkpoint privileges unchanged. Checkpoint failures happen
before snapshot replacement or data restoration, preserving the prior state.
