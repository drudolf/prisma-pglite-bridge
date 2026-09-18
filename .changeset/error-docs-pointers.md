---
"prisma-pglite-bridge": minor
---

Every `PgBridgeError` and bridge warning message now ends with a docs
pointer, `(docs: prisma-pglite-bridge/docs/troubleshooting.md#<code>)`,
and `PgBridgeError` gains a `docs` property carrying the same
package-relative pointer. `docs/troubleshooting.md` gains a section per
error code and warning. The `BRIDGE_OPTIONS_REQUIRED` message now
diagnoses the usual cause — a duplicated `pg` package — and names the
fix. If you matched on message text, match on `code` instead or strip
the trailing `(docs: …)` tail.
