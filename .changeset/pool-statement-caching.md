---
"prisma-pglite-bridge": minor
---

Add pool-level statement caching via named prepared statements.

`PgBridgePool` now exposes a `statementCaching` option (default: enabled) that makes each pool client inject a stable, client-unique `ppb_<namespace>_<n>` name into each unnamed DML query — SELECT, INSERT, UPDATE, DELETE, WITH, MERGE, VALUES — so PGlite parses and plans each query shape once per client and skips the Parse round-trip on repeat executions. Non-DML statements (DDL, SET, transaction control) run unnamed and are never cached.

This covers all **object-form** query paths through the pool — Prisma adapter traffic, `pool.query({ text, values })`, and ORMs like Drizzle that issue object-form queries — since the injection happens at the client layer. String-form queries (`pool.query('SELECT 1')`) are intentionally excluded; they reach PGlite via the simple protocol and do not benefit from named-statement caching.

Statement names draw from a process-wide namespace counter, so no two clients — across pools, across client generations — ever prepare the same name into the shared PGlite session: name collisions (Postgres error 42P05) are impossible by construction, and caching is safe at any `max` and with any number of pools. User-supplied statement names (`query({ name: ... })`) bypass injection and remain single-client-only on the shared session.

Bounded at 500 distinct query texts per client; shapes beyond that run unnamed (correct, just uncached).

Also adds DEALLOCATE / DISCARD ALL interception: after a `DEALLOCATE ALL`, `DEALLOCATE <name>`, or `DISCARD ALL` query issued through any pool client resolves, the affected entries are evicted from **every** live client's plan cache on that PGlite instance (pg's internal `parsedStatements` guard and the fast-path fields cache), so the next execution for the same SQL re-sends Parse and gets a fresh plan instead of failing with Postgres error 26000. Deallocation targets follow PostgreSQL identifier rules — unquoted names fold to lowercase, quoted names match exactly.
