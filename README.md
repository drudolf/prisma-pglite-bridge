# prisma-pglite-bridge

In-process PGlite bridge for Prisma. Replaces the TCP socket in
`pg.Client` with a Duplex stream that speaks PostgreSQL wire protocol
directly to PGlite's WASM engine.

## Install

Requires **Prisma 7+** and **Node.js 20+**.

```sh
pnpm add -D prisma-pglite-bridge @electric-sql/pglite @prisma/adapter-pg pg
```

The last three are peer dependencies you may already have.
TypeScript users also need `@types/pg`.

## Quickstart

```typescript
import { PGlite } from '@electric-sql/pglite';
import { createPGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import seed from './seed.ts'; // user-provided: (prisma: PrismaClient) => Promise<void>

const pglite = new PGlite();
const bridge = await createPGliteBridge({ pglite });
await pushMigrations(bridge, { migrationsPath: './prisma/migrations' });

const prisma = new PrismaClient({ adapter: bridge.adapter });
await seed(prisma);
await bridge.snapshotDb();

beforeEach(() => bridge.resetDb());
```

`snapshotDb()` captures the seeded state once. `resetDb()` in
`beforeEach` then restores each test to that snapshot — fast,
deterministic, no re-seeding per test. Skip the snapshot/reset
pair if your tests are read-only or you want state to carry
over.

That's it. Run `prisma migrate dev` first to generate migration
files. No Docker, no database server — works in GitHub Actions,
GitLab CI, and any environment where Node.js runs.

For projects without a `prisma/migrations` directory (test
fixtures, prototypes), see [Populating the
database](./docs/api.md#populating-the-database) for the
`pushSchema` alternative.

## Documentation

- **[API reference](./docs/api.md)** — exports, options, return
  values, fs-sync policy.
- **[Cookbook](./docs/cookbook.md)** — Vitest / Jest setup,
  per-test isolation, seed sharing, extensions, persistent dev
  database, clean shutdown.
- **[`PGliteServer`](./docs/server.md)** — TCP / Unix-socket
  front for PGlite. Use for the Prisma CLI shadow database, `psql`,
  and SQL GUIs.
- **[Stats and diagnostics](./docs/stats.md)** — `stats()`
  snapshots and `node:diagnostics_channel` event streams.
- **[Troubleshooting & limitations](./docs/troubleshooting.md)** —
  known issues (PGlite version mismatch, WASM `ExperimentalWarning`)
  and runtime constraints.

## License

MIT
