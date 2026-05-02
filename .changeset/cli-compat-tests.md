---
"prisma-pglite-bridge": patch
---

Add `cli-compat` test project covering `PGliteServer` end-to-end
through real CLI binaries:

- `psql` (skipped when not installed)
- `prisma db push`, `db pull`, `db execute`
- `prisma migrate dev` (multi-migration), `migrate deploy`,
  `migrate reset`, `migrate status` — Prisma 7, with the shadow
  database backed by a second `PGliteServer` instance

Run with `pnpm test:cli-compat`. Tests are scoped to their own
vitest project so the default suite stays fast.
