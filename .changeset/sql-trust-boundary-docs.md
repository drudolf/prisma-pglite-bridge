---
'prisma-pglite-bridge': patch
---

Document the source-of-trust requirement for schema SQL. Both
`sql` and `migrationsPath` execute verbatim with no checksum or
signature verification, so anyone who can influence either string
controls the schema. The README now states this explicitly in
Schema Resolution and repeats a short warning before the
"Pre-generated SQL (fastest)" example.
