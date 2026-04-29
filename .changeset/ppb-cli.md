---
"prisma-pglite-bridge": minor
---

Add the `ppb` CLI with `db-push` and `db-reset` subcommands. Applies a
Prisma schema to a PGlite database in-process via the
`@prisma/schema-engine-wasm` engine — no native schema-engine binary,
no Docker. Reads `DATABASE_URL` as a `pglite://` URL or accepts
`--data-dir` directly.
