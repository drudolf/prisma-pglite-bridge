---
"prisma-pglite-bridge": minor
---

`PGliteServer` gains `resetDb(options?)`, `snapshotDb(options?)`, and
`resetSnapshot(options?)` (`ServerSessionOptions { timeoutMs?: number }`,
default 5000). Each runs as the owner of the shared session: it fails
fast with the new error code `SERVER_NOT_IDLE` while any connection is
inside a transaction, otherwise queues behind the running statement and
throws `SERVER_NOT_IDLE` once `timeoutMs` elapses; `SERVER_CLOSED` and
`SERVER_PGLITE_CLOSED` cover the lifecycle, and `close()` cancels queued
waiters. The server path does not scrub session state — `SET`s,
`LISTEN`s, temp tables, and advisory locks on the app's connections
survive — because the session belongs to the connected app. Anything
that reaches `server.pglite` outside the server (a direct `exec`, a
companion `PGliteBridge` or `PgBridgePool`) must be idle when these are
called. Snapshot state is now read from the database on every reset,
so a bridge and a server over the same PGlite agree on it. The bridge's
`resetDb()` restore now runs in one transaction with `SET LOCAL
session_replication_role`: a failed restore leaves the data untouched
and the GUC never leaks into the session. The `_prisma%` table filter
now escapes the underscore, so it matches only the `_prisma` prefix.
