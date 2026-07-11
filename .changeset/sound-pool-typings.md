---
"prisma-pglite-bridge": patch
---

Internal: replace the pool's `as unknown as` casts over pg internals with
sound typings. A `pg` module augmentation declares the extended-protocol
connection seam that `@types/pg` omits (`parsedStatements`, `sendCopyFail`,
and the one-arg `parse`/`bind`/`describe`/`execute`/`close` forms), so
`FastQuery.submit` and the statement-cache eviction read it without a cast;
pool-event clients narrow via `instanceof PgBridgeClient`. No behavior change.
