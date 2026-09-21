---
"prisma-pglite-bridge": patch
---

Reduce overhead for large SQL statements by skipping COPY classification when
the required keywords are absent, searching standard quoted literals directly,
and limiting query-trail case conversion to the statement prefix. Keep
query-trail overflow constant-time at large capacities
while preserving entry order and pending-query settlement.
