# prisma-pglite-bridge

In-process PGlite bridge for Prisma. Replaces the TCP socket in
`pg.Client` with a Duplex stream that speaks PostgreSQL wire protocol
directly to PGlite's WASM engine.

Everything else is your production stack: the real `pg` client and
the official `@prisma/adapter-pg` run unchanged, so tests exercise
the identical adapter, wire-protocol serialization, and type-parsing
code path they ship with — only the transport differs.

## Install

Requires **Prisma 7+** and **Node.js 22+**.

```sh
pnpm add -D prisma-pglite-bridge
```

pnpm and npm auto-install the peer dependencies —
`@electric-sql/pglite`, `@prisma/adapter-pg`, and `pg`. In a
Prisma-on-Postgres project they are already your production stack;
the bridge deliberately reuses your copies rather than bundling
its own.

On Yarn (which does not auto-install peers), or to keep the peers
visible in your `package.json` so upgrades stay deliberate and
bot-managed, list them explicitly:

```sh
pnpm add -D prisma-pglite-bridge @electric-sql/pglite @prisma/adapter-pg pg
```

TypeScript works out of the box — `@prisma/adapter-pg` ships `pg`'s
type declarations. Add `@types/pg` only if your own code imports
`pg` directly.

Using the bridge without Prisma (drizzle, kysely, knex, typeorm,
mikro-orm)? Import from `prisma-pglite-bridge/pool` — that entry never
loads `@prisma/*` code at runtime. The Prisma packages still land in
`node_modules` (the peers above plus a ~5.5 MB schema engine) until
2.0; they are install weight only on this path.

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

On reads, the wire-protocol path is roughly 2x faster than going
through a direct PGlite driver adapter — on every latency percentile
and every query shape — and ahead of a *native local* PostgreSQL
server on both Apple Silicon and x86 with the 1.7 defaults
(prepared-statement caching plus the fast query path; opt out with
`preparedStatements: false`). Prisma `findMany({ take: 100 })`, 1000
iterations, PGlite 0.5.3 (reproduced on 0.5.4), measured 2026-07-06:

| Machine | bridge (p50 / p99) | direct adapter (p50 / p99) | native Postgres (p50 / p99) |
| ------- | ------------------ | -------------------------- | --------------------------- |
| Apple M3 Max | **0.33ms / 0.54ms** | 0.88ms / 1.90ms | 0.40ms / 1.05ms |
| Apple i9-9980HK | **0.87ms / 1.73ms** | 2.45ms / 4.95ms | 1.03ms / 2.80ms |
| Linux i7-8700 | **0.67ms / 1.01ms** | 1.69ms / 4.10ms | 0.95ms / 2.76ms |

That lead isn't an artifact of one hot query: across a nine-shape
read mix (point lookups, filters, sorts, joins, `count`/`groupBy`)
the bridge stays ahead on every shape and machine, and it now wins
indexed interactive transactions on every machine too. The trade-offs
are honest, though — give native Postgres prepared statements and the
read median becomes a near-tie (native wins it outright on one of the
three machines and keeps the tightest worst case everywhere), and
native's faster sequential scan still takes unindexed sorts on Apple
Silicon. Full tables (operation breadth, multi-shape
reads, transactions, memory, cold start, where native wins) and
methodology live in the
[benchmark suite](./benchmark/BENCHMARK.md). Reproduce with:

```sh
NODE_OPTIONS="--expose-gc" pnpm bench --scenario findmany-focused -n 1000 -w 100 -r 5
```

The same wire path serves other ORMs: `PgBridgePool` is a `pg.Pool`,
so drizzle, kysely, knex, typeorm, and mikro-orm run their standard
Postgres dialects on PGlite through `prisma-pglite-bridge/pool` — a
Prisma-free entry — and beat their native PGlite drivers on every
measured operation (query-builder p50 2.2–3.9×, typeorm 1.7–2.5×,
mikro-orm 1.4–1.9×; spreads in the
[ORM tables](./benchmark/BENCHMARK.md)). The mechanism is the same one
behind the Prisma numbers: PGlite's public `query()` API takes a mutex
and makes ~6 WASM protocol crossings per call, while the bridge issues
one buffered raw-stream write. Wiring recipes and driver-agnostic
testing helpers live in the
[cookbook](./docs/cookbook.md#other-orms).

Test-setup cost matters as much as query speed for a suite.
`createBridgeTest`'s `scope` trades isolation against per-test
overhead: `'file'` / `'worker'` reset one shared snapshot (tens of
ms/test), while `'test'` hands every test its own independent,
`test.concurrent`-safe PGlite loaded from a per-file template — ~5x
cheaper than a full cold start per test and far more predictable
(sub-second p99 on Apple Silicon and x86, vs a cold-start tail that
runs to seconds). Numbers and the `pnpm bench:isolation` entry point
live in [per-test isolation
cost](./benchmark/BENCHMARK.md#per-test-isolation-cost).

## Documentation

- **[API reference](./docs/api.md)** — exports, options, return
  values, fs-sync policy.
- **[Cookbook](./docs/cookbook.md)** — one-call Vitest / Jest
  setup (`prisma-pglite-bridge/vitest`,
  `prisma-pglite-bridge/jest`), per-test isolation, seed sharing,
  extensions, persistent dev database, clean shutdown.
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
