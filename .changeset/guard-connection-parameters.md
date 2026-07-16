---
"prisma-pglite-bridge": patch
---

The construction-time pg-internals guard now also verifies
`client.connectionParameters` (an object with an own `query_timeout`), the
field the bridge suppresses and restores around managed submissions. A pg
build lacking it now fails deterministically at client construction instead
of misbehaving at query time, and the query-timeout path reads the field
through the typed seam instead of a local cast.
