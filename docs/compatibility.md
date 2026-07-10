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
| `pg-copy-streams` | ✅ | Bulk load via COPY FROM STDIN (captured and executed atomically) and dump via COPY TO STDOUT; mid-stream errors and client aborts recover cleanly |

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
- **COPY FROM STDIN is captured, then executed atomically.** PGlite's
  WASM backend cannot suspend mid-COPY waiting for more input, so the
  duplex answers the copy query with a synthetic `CopyInResponse`,
  buffers the client's data stream (default cap 256 MiB,
  `PGliteDuplexOptions.copyAggregateCapBytes`), and runs the whole
  conversation as one call on `CopyDone`/`CopyFail`. Consequences:
  server-side errors (missing table, malformed rows) surface only
  after the client finishes sending — unlike real Postgres, which
  errors before copy mode begins; peak transient memory is roughly 2×
  the payload; a cap breach degrades to a catchable in-band error,
  never a teardown. Multi-statement simple queries containing
  `COPY ... FROM STDIN` are rejected with an in-band error (forwarding
  one would kill the WASM instance), and extended-protocol COPY is not
  supported — `pg-copy-streams` and psql-style clients use the simple
  protocol, which is the supported path.

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
