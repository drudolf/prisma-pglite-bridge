---
"prisma-pglite-bridge": minor
---

# Initial release

In-process PGlite bridge for Prisma — replaces the TCP socket
in `pg.Client` with a Duplex stream that speaks PostgreSQL wire
protocol directly to PGlite's WASM engine. Zero Docker, zero
database server.

- `createPgliteAdapter()` — Prisma adapter with auto-discovered
  migrations, explicit path, or raw SQL
- `createPool()` — lower-level `pg.Pool` backed by PGlite
- `PGliteBridge` — Duplex stream for custom `pg.Client` setups
- `resetDb()` — truncates user tables and resets session state
  for per-test isolation
- Connection pooling with `SessionLock` to serialize transactions
- Supports PGlite extensions and persistent `dataDir`
