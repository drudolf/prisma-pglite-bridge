---
"prisma-pglite-bridge": patch
---

Statement caching now uses usage-gated LRU admission instead of a frozen cap. A query shape earns its `ppb_` name on its second sighting (one-shot statements never occupy cache slots), and past 500 distinct shapes the least-recently-used statement is evicted and freed with a wire-protocol `Close('S')` that rides the next query's message batch — no dedicated round trip, and unlike `DEALLOCATE` it works inside failed transactions. Previously the first 500 shapes kept their names forever and every shape after ran permanently unnamed (100% re-parse when a workload's hot set shifts past the cap). Statement names remain monotonic and never reused, so a delayed Close can never misdirect an execution. Below the cap the only change is one extra unnamed execution per shape at cold start; the policy matches what pgJDBC, Npgsql, pgx, asyncpg, psycopg3, and PgBouncer ship (LRU + piggybacked wire Close; pgJDBC/Npgsql/psycopg3 also gate admission).
