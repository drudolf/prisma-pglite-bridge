# prisma-pglite-bridge

## 0.3.1

### Patch Changes

- [`6422d64`](https://github.com/drudolf/prisma-pglite-bridge/commit/6422d64b368d9807a5a6ecce9d7ddb1aa4142e7a) Thanks [@drudolf](https://github.com/drudolf)! - # Migrate build toolchain to tsdown and TypeScript 6

  Switch from tsup (esbuild) to tsdown (Rolldown) for bundling, and
  upgrade TypeScript from 5.9 to 6.0. Also updates Biome from 1.9 to
  2.4 and @types/node from 22 to 25.

## 0.3.0

### Minor Changes

- [`53e5465`](https://github.com/drudolf/prisma-pglite-bridge/commit/53e54654ec77bfb2d7aaaa2a649cef7487533fa0) Thanks [@drudolf](https://github.com/drudolf)! - # Add snapshotDb/resetSnapshot for fast test isolation

  `snapshotDb()` captures the current database state into a shadow schema.
  Subsequent `resetDb()` calls restore from the snapshot instead of
  truncating to empty, avoiding expensive re-seeding through the Prisma
  wire protocol.

  Also fixes sequence save/restore: `quote_ident` was producing bare
  identifiers that PostgreSQL interpreted as column references; switched
  to `quote_literal` and added a `last_value IS NOT NULL` filter for
  never-called sequences.

## 0.2.0

### Minor Changes

- [`8a42dc8`](https://github.com/drudolf/prisma-pglite-bridge/commit/8a42dc80d47bae61ff28f143ce7e8ccd5013c3b6) Thanks [@drudolf](https://github.com/drudolf)! - # Initial release

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
