---
"prisma-pglite-bridge": minor
---

Add `createPGliteServer({ pglite })` — a TCP or Unix-socket listener
that exposes a PGlite instance to standard Postgres clients (`psql`,
Prisma CLI shadow DB, DBeaver, Studio). Pass `socketDir` (and optional
`socketPort`, default `5432`) for a Unix socket — the library binds
the libpq-conventional `<socketDir>/.s.PGSQL.<socketPort>` so clients
connect with just `host=<socketDir>`. Otherwise binds TCP loopback.
Each accepted socket gets its own `PGliteDuplex` sharing a single
`SessionLock`, so transactions across connections serialize correctly.
No auth — intended for development and the Prisma `migrate dev`
shadow DB.

Also: `PGliteDuplex` now rolls back any open transaction on `_final`,
`_destroy`, and `Terminate`. Transaction detection lives on the duplex
itself (via the last observed ReadyForQuery status), not on
`SessionLock`, so cleanup runs for both locked pools (`max>1`, TCP
server) and standalone duplexes (default `max=1` pool). Awaiting any
in-flight `pglite.execProtocolRawStream` call before deciding closes
the BEGIN-in-flight race where ownership had not yet been recorded.
A client disconnect mid-transaction — Terminate, hard-disconnect, or
`pool.release(err)` — no longer leaks `T` state into the next
connection.
