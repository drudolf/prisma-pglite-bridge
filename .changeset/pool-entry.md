---
"prisma-pglite-bridge": minor
---

New `prisma-pglite-bridge/pool` entry: the Prisma-free subset of the root
export — `PgBridgePool`, `PGliteDuplex`, `SessionLock`, `PgBridgeError`,
and the diagnostics channels — through a module graph that never imports
`@prisma/*` (enforced in CI by a dist purity gate and a no-Prisma install
smoke test). Non-Prisma ORMs (drizzle, kysely, knex, typeorm, mikro-orm)
wire their standard Postgres dialects to the pool and run on PGlite
2.2–3.9× faster than the native PGlite drivers; recipes in the cookbook's
"Other ORMs" section. Note: "Prisma-free" is import-graph-only — the
package's Prisma dependencies still install (~5.6 MB) until 2.0.
