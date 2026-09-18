---
"prisma-pglite-bridge": minor
---

`pushMigrations` with a migrations directory (`migrationsPath` or
auto-discovered) now keeps Prisma's `_prisma_migrations` history —
same table DDL, same checksum, same rows as `prisma migrate deploy`.
The Prisma CLI (`migrate status` / `deploy` / `dev` through
`PGliteServer`) sees the migrations as applied, and a second call on a
persistent `dataDir` skips them, so the `hasSchema` guard around
`pushMigrations` is no longer needed. Migrations are applied one at a
time at Prisma's granularity (one `exec` per migration, started row
before, finished row after) instead of as one all-or-nothing batch: a
failing script now leaves the earlier migrations applied and its own
started row in place, as under Prisma's runner. The result gains
`applied` and `skipped` (migration names). New error code
`MIGRATIONS_HISTORY_INVALID` fires before applying when the history
holds a failed, duplicate, orphaned, or modified migration, or when
tables exist with no history at all (Prisma's P3005); the message names
the `prisma migrate resolve` repair. Persistent `dataDir`s populated by
an earlier `pushMigrations` hit that last case on upgrade: baseline them
with `prisma migrate resolve --applied <name>` per migration through a
`PGliteServer`, or start from an empty directory. `hasMigrations` is now `true`
after `pushMigrations`, and `hasSchema` ignores `_prisma%` tables. The
`sql` path is unchanged: one batch, no bookkeeping, not idempotent.
