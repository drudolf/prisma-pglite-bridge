---
"prisma-pglite-bridge": patch
---

Evict statement caches when DEALLOCATE / DISCARD ALL is issued through a
Submittable (`client.query(new pg.Query('DEALLOCATE ALL'))`). Previously the
backend dropped its prepared statements while every live client's plan cache
stayed warm, so subsequent named executions failed persistently with
Postgres error 26000. Eviction fires exactly once on the query's real
completion via pg's own channels (wrapped callback plus the `'end'` event),
covering the fired-`query_timeout` case; errors evict nothing. Submittables
exposing neither channel are a documented fail-closed exception.
