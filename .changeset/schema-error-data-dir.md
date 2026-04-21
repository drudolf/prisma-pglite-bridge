---
'prisma-pglite-bridge': patch
---

Embed the PGlite `dataDir` (when present) in the schema-apply error
thrown by `createPgliteAdapter`. Persistent instances now surface as
`PGlite(dataDir=/path/to/db)` in the message, so failures from
multi-instance test runs point at the right database instead of the
generic "PGlite" string.
