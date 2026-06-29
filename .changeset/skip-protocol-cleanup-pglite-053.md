---
"prisma-pglite-bridge": patch
---

Skip the redundant PGlite protocol-message cleanup on PGlite >= 0.5.3, where
electric-sql/pglite#1030 removed the raw-stream result accumulation the cleanup
compensated for. The bridge reads its resolved PGlite version and only runs the
cleanup on older runtimes, or when the version can't be determined.
