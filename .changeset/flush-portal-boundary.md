---
"prisma-pglite-bridge": patch
---

Fix row-limited queries hanging forever: `Flush` now flushes the EQP pipeline as a portal boundary instead of being buffered until `Sync`. This unblocks pg's `rows: N` option, pg-cursor, and pg-query-stream, which drive portal suspension with Flush. During a suspension window the duplex holds the session lock so concurrent pool clients cannot clobber the suspended portal, and after a mid-portal error it issues a recovery Sync so the session stays usable (stock pg never sends one in rows mode). Note for stats/diagnostics consumers: a row-limited query now records one query event per Flush round-trip plus the terminating Sync, rather than a single event.
