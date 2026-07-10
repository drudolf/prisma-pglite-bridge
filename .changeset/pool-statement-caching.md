---
"prisma-pglite-bridge": minor
---

Prepared-statement caching, on by default.

Each pool client injects a stable, client-unique `ppb_<namespace>_<n>` name into each unnamed DML query — SELECT, INSERT, UPDATE, DELETE, WITH, MERGE, VALUES — so PGlite parses and plans each query shape once per client and skips the Parse round-trip on repeat executions (~7% lower read p50, ~18% lower p99 in the reference benchmark). Non-DML statements (DDL, SET, transaction control) run unnamed and never consume cache slots; the cache names the first 500 distinct texts per client (bounded and frozen, not LRU), and shapes beyond that run unnamed — correct, just uncached.

This covers every extended-protocol query path through the pool, since the injection happens at the client layer: Prisma adapter traffic, object-form queries (`pool.query({ text, values })` — e.g. Drizzle), and string-form parameterized queries (`pool.query(text, values)` with a non-empty values array — e.g. Kysely and TypeORM; measured ~20% lower p50 on parse-heavy single-statement ops for that traffic). Parameterless string queries (`pool.query('SELECT 1')`) and empty-values calls stay on the simple protocol, unnamed. ORMs that emit many distinct texts (e.g. variable-arity `IN ($1, $2, …)` lists) consume cache slots faster — texts beyond the cap simply run unnamed — and ORMs that inline parameters into the SQL text (no bind values, e.g. MikroORM v7) send no repeat shapes and are unaffected.

Statement names draw from a process-wide namespace counter, so no two clients — across pools, across client generations — ever prepare the same name into the shared PGlite session: name collisions (Postgres error 42P05) are impossible by construction, and caching is safe at any `max` and with any number of pools. User-supplied statement names (`query({ name: ... })`) bypass injection and remain single-client-only on the shared session.

Also adds DEALLOCATE / DISCARD ALL interception: after a `DEALLOCATE ALL`, `DEALLOCATE <name>`, or `DISCARD ALL` query issued through any pool client resolves, the affected entries are evicted from **every** live client's plan cache on that PGlite instance (pg's internal `parsedStatements` guard and the fast-path fields cache), so the next execution for the same SQL re-sends Parse and gets a fresh plan instead of failing with Postgres error 26000. Deallocation targets follow PostgreSQL identifier rules — unquoted names fold to lowercase, quoted names match exactly.

Supporting changes:

- Opt out with `PgBridgePoolOptions.statementCaching: false` or `PGliteBridgeOptions.preparedStatements: false`. Disable it if you issue DDL mid-session that changes the result type of an already-cached query shape (fails with "cached plan must not change result type"; applying schema before Prisma traffic, as the setup helpers do, is safe). See docs/troubleshooting.md.
- Pool clients are no longer evicted after 10s idle: `PgBridgePool` now defaults `idleTimeoutMillis` to `0` (never evict), so the statement cache survives idle gaps. An in-process client holds no socket or server resources. Configurable via the new `PgBridgePoolOptions.idleTimeoutMillis`.
