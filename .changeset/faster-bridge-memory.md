---
"prisma-pglite-bridge": minor
---

Improve bridge performance and memory behavior under Prisma workloads.

The bridge now periodically clears PGlite's internal parsed protocol
message cache after bounded protocol traffic, which prevents retained
RSS growth during repeated large reads while preserving the streaming
wire-protocol path. The cleanup is best-effort and disables itself if a
future PGlite version no longer supports the verified cleanup behavior.

Also reduce per-query overhead by avoiding unnecessary pipeline
concatenation when pg sends contiguous extended-query protocol batches,
skipping RowDescription copies unless catalog `"char"` fields need
rewriting, and simplifying `PgBridgeClient` query submission so idle
clients dispatch immediately with less promise-chain overhead.
