---
"prisma-pglite-bridge": minor
---

Support multiple concurrent `PgBridgePool`s (and `PGliteBridge`s) on one PGlite instance. Connect-time session cleanup now runs only for the first live client counted across all pools, so neither a new pool nor a lazily created second client at `max > 1` deallocates a sibling's cached prepared statements (Postgres error 26000). Statement names are unique per pool client, so pools never contend for names (42P05) and named-statement caching stays fully active while pools overlap — no suspension, no handover resync; a surviving pool's cache stays warm through sibling churn. `PGliteBridgeSharedInstanceWarning` is now an advisory (serialization, transaction interleaving) instead of declaring the setup unsupported. Transactions from different pools can still interleave; coordinate explicitly if cross-pool isolation matters.
