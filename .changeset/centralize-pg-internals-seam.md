---
"prisma-pglite-bridge": patch
---

Internal: centralize the pg-internals seam — the `parsedStatements` type,
`prepareValue`, the extended-protocol connection type, and the active-query
accessor — into a single `pg-internals` module so a pg upgrade surfaces in one
place. No behavior change.
