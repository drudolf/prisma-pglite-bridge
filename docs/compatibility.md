# pg-ecosystem compatibility

`PgBridgePool` speaks the real PostgreSQL wire protocol to PGlite, so
packages built on [node-postgres](https://node-postgres.com/) work
without adapters. This matrix is produced by a runnable harness —
`pnpm bench:compat` (`benchmark/compat/`) — that exercises each package
against a fresh PGlite instance and reports what actually worked; it is
re-run against changes, not maintained by hand.

Status as of 2026-07-10 (bridge 1.7.0-pre, PGlite 0.5.4):

| Package / feature | Status | What the probe verifies |
| ----------------- | :----: | ----------------------- |
| `pg-cursor` | ✅ | Paged reads via `Execute(n)`+Flush portal suspension; early close mid-stream keeps the client usable |
| `pg-query-stream` | ✅ | Readable row streams with async iteration and backpressure; early destroy mid-portal recovers |
| `LISTEN`/`NOTIFY` | ✅ | Async `NotificationResponse` delivery to pg's `'notification'` event, payload intact |
| `node-pg-migrate` | ✅ | Programmatic up/down migrations, including `pg_advisory_lock` coordination |
| `pg-boss` | ✅ | Job queue end-to-end on the custom-`db` seam: schema install (multi-statement DDL), send, fetch, complete |
| `pg-copy-streams` | ❌ | COPY FROM STDIN — the duplex has no COPY sub-protocol handling; fails with a protocol-synchronization error (roadmap) |

Notable: none of the ORMs' native PGlite drivers support cursors or
streaming at all (MikroORM's official driver documents `em.stream()` as
unsupported) — on the bridge, `pg-cursor`-based streaming works,
including kysely's `.stream()` and everything else built on
`pg-query-stream`.

## Semantics to know about

- **One shared session.** All pool clients multiplex one PGlite
  session. `LISTEN` registrations are session-wide: every client of the
  pool observes notifications for any channel any of them listens on,
  and `NOTIFY` from a pool client self-delivers. Fine for testing
  workloads; different from one-backend-per-connection Postgres.
- **Advisory locks work** (`pg_advisory_lock` and friends), but they
  coordinate within the single session — cross-process exclusion
  semantics do not apply to an in-process database.
- **COPY is not supported yet.** `pg-copy-streams` (and anything else
  driving `CopyInResponse`/`CopyData`) fails; use multi-row `INSERT`s
  or [`pushMigrations`](./api.md#pushmigrationspglite-options) for bulk
  seeding until COPY lands.

## Running and extending

```bash
pnpm bench:compat                    # all probes
pnpm bench:compat --probe pg-boss    # one probe
```

A failing probe is a report, not a harness error — the run always
completes and prints the matrix. Probes get a fresh PGlite + pool, a
hard deadline, and async-error capture (protocol violations surface as
matrix rows, not crashes). To add a package: implement `CompatProbe` in
a sibling of `benchmark/compat/pg-cursor.ts`, register it in `run.ts`'s
`PROBES` map, and add the package as a devDependency.
