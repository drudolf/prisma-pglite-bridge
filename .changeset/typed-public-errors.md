---
"prisma-pglite-bridge": minor
---

User-actionable failures now throw the new `PgBridgeError` (exported with
the `PgBridgeErrorCode` union) carrying a machine-readable `code` —
`UNSUPPORTED_PG_INTERNALS`, `POOL_NOT_IDLE`, `MIGRATIONS_UNAVAILABLE`,
`MIGRATIONS_APPLY_FAILED` (with `cause`), `SNAPSHOT_INVALID`, and friends —
so callers can discriminate bridge misconfiguration programmatically instead
of parsing message strings. Messages are unchanged and `instanceof Error`
still holds; note that `error.name` at these sites is now `'PgBridgeError'`
instead of `'Error'`. Codes are stable within a major version. Argument-type
validation keeps `TypeError`; protocol-integrity and pg-parity errors stay
plain `Error`. All public throw paths now carry `@throws` documentation.
