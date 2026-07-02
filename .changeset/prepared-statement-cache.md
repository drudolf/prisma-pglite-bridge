---
"prisma-pglite-bridge": minor
---

`PGliteBridge` now caches Prisma queries as named prepared statements by
default (new `preparedStatements` option), so PGlite parses and plans each
query shape once per session instead of on every execution — WASM
parse/plan is the single largest per-query cost, and this removes it from
the hot path (~35% lower read p50 in the reference benchmark).

Prepared statements survive `resetDb()`: the reset now issues the granular
equivalent of `DISCARD ALL` without `DEALLOCATE ALL` (session variables,
temp tables, cursors, advisory locks, and cached plans are still cleared).
Tables are truncated, never dropped, so retained statements revalidate
transparently and the cache stays warm across per-test resets.

The default is enabled only at `max: 1` (the default pool size): PGlite is
a single shared session, so named statements prepared through different
pool clients would collide. Set `preparedStatements` explicitly to
override in either direction.

Also fixed along the way: prepared statements now behave like on a real
server across connection lifecycles. PGlite's shared session used to leak
named statements from a destroyed pool client into its replacement
(42P05 "prepared statement already exists"); every fresh bridge
connection now starts with a clean statement namespace.
