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
import { PGliteBridge, pushMigrations } from 'prisma-pglite-bridge';
import { PrismaClient } from '@prisma/client';
import seed from './seed.ts'; // user-provided: (prisma: PrismaClient) => Promise<void>

const bridge = new PGliteBridge();
// Have prisma/migrations/? Use pushMigrations (shown).
// Only schema.prisma? Use pushSchema instead — see docs/api.md.
await pushMigrations(bridge.pglite, { migrationsPath: './prisma/migrations' });

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

Running the Prisma CLI against this bridge (shadow DB for
`migrate dev`, `psql`, SQL GUIs)? See
[`PGliteServer`](./docs/server.md) for the TCP/Unix-socket front.

## Performance

The wire-protocol path is ~2x faster than going through a direct
PGlite driver adapter — on every latency percentile, and roughly on
par with a *native local* PostgreSQL server on hot read loops.
Prisma `findMany({ take: 100 })`, 1000 iterations, PGlite 0.5.3:

| Machine | bridge (p50 / p99) | direct adapter (p50 / p99) | native Postgres (p50 / p99) |
| ------- | ------------------ | -------------------------- | --------------------------- |
| Apple M3 Max | **0.43ms / 1.21ms** | 0.83ms / 1.83ms | 0.43ms / 1.43ms |
| Intel i9-9980HK | 1.07ms / **2.51ms** | 2.16ms / 4.92ms | **0.97ms** / 2.85ms |

Trade-offs and losses included: full tables (operation breadth,
memory, cold start, where native Postgres wins), methodology, and
raw JSON snapshots live in the
[benchmark suite](./benchmark/BENCHMARK.md). Reproduce with:

```sh
NODE_OPTIONS="--expose-gc" pnpm bench --scenario findmany-focused -n 1000 -w 100 -r 5
```

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
