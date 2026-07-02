---
"prisma-pglite-bridge": minor
---

New opt-in `preparedStatements` option on `PGliteBridge`: caches Prisma
queries as named prepared statements so PGlite parses and plans each query
shape once per session instead of on every execution (~7% lower read p50,
~18% lower p99 in the reference benchmark; WASM parse/plan is the single
largest per-query cost). Unlike many production Postgres setups
(transaction-mode poolers break named statements), the bridge can always
run with it on — but it stays off by default so session semantics change
only when you ask.

Prepared statements survive `resetDb()`: the reset now issues the granular
equivalent of `DISCARD ALL` without `DEALLOCATE ALL` (session variables,
temp tables, cursors, advisory locks, and cached plans are still cleared).
Tables are truncated, never dropped, so retained statements revalidate
transparently and the cache stays warm across per-test resets.

Also fixed: statements prepared through a destroyed pool client survived
in PGlite's shared session and collided with replacement clients
re-preparing the same names (42P05 "prepared statement already exists").
Every fresh bridge connection now starts with a clean statement namespace,
matching real-server semantics.
