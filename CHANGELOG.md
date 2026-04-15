# prisma-pglite-bridge

## 0.4.1

### Patch Changes

- [`38116f9`](https://github.com/drudolf/prisma-pglite-bridge/commit/38116f93ab77b47fb192d50c971c2e476845b6ce) Thanks [@drudolf](https://github.com/drudolf)! - Fix `SessionLock` wait queue to drain one bridge at a time instead of all at once. Prevents a race where multiple waiters bypass the lock simultaneously after a transaction completes.

- [`38116f9`](https://github.com/drudolf/prisma-pglite-bridge/commit/38116f93ab77b47fb192d50c971c2e476845b6ce) Thanks [@drudolf](https://github.com/drudolf)! - Harden transaction safety in `writeSentinel` and migration application with proper ROLLBACK on failure. Fix snapshot identifier quoting — store raw schema/table names and apply `quote_ident` only on retrieval, preventing double-quoting. Move sequence restore inside the `session_replication_role` try block.

## 0.4.0

### Minor Changes

- [`1006069`](https://github.com/drudolf/prisma-pglite-bridge/commit/10060690546e5b6b8b808f1819717ae384a84cb3) Thanks [@drudolf](https://github.com/drudolf)! - Replace catalog-guessing `isInitialized` with sentinel-based detection for persistent `dataDir` reopens. Uses a `_pglite_bridge.__initialized` marker table with transactional writes, pre-commit verification, and a legacy fallback for pre-sentinel databases. Fixes sequence-only and function-only schemas not being detected on reopen.

## 0.3.2

### Patch Changes

- [`c4c5a3e`](https://github.com/drudolf/prisma-pglite-bridge/commit/c4c5a3e869394d987f86cfda07d9f09966399fed) Thanks [@drudolf](https://github.com/drudolf)! - Export `SessionLock` from the public API for advanced multi-bridge use cases.

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
