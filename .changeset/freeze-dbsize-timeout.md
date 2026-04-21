---
'prisma-pglite-bridge': patch
---

Time out the `pg_database_size` query issued from `AdapterStats.freeze`
and `AdapterStats.snapshot` after 5 seconds. A hung PGlite query
previously left `freeze()` awaiting forever, which meant the RSS
sampling interval was never cleared and the adapter's `close()` never
resolved. The timeout rejects internally and is caught by the existing
handler, so `dbSizeBytes` simply becomes `undefined` — the rest of
`stats()` remains intact and `close()` always settles.
