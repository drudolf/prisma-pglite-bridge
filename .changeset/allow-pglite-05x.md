---
"prisma-pglite-bridge": minor
---

Allow PGlite 0.5.x: the `@electric-sql/pglite` peer range is now
`^0.4.0 || ^0.5.0`. Validated against PGlite 0.5.1 (PostgreSQL 18.3) across
the full test suite, including Prisma CLI compatibility — together with the
PostgreSQL 18 introspection workaround and the `PGliteServer` catalog-OID
fix shipped in this release.
