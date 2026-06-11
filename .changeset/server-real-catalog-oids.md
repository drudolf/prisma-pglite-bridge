---
"prisma-pglite-bridge": patch
---

`PGliteServer` no longer widens system-catalog `"char"` columns (OID 18) to
text (OID 25) in RowDescription frames. The widening is an
`@prisma/adapter-pg` accommodation that belongs to the bridge path only;
native clients (Prisma CLI engine, psql, GUIs) need the real OID. With the
rewrite, the CLI's schema engine misread `pg_constraint.contype` as text and
failed on PostgreSQL 18's NOT NULL constraint rows (`prisma db pull`,
`prisma migrate dev`). The rewrite is now controlled by a new
`rewriteSystemCatalogCharOids` option on `PGliteDuplex` (default `true`;
the server passes `false`).
