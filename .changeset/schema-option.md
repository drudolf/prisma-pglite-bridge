---
"prisma-pglite-bridge": minor
---

New `schema` option on `PGliteBridge` (and, via the `bridge` option, the
vitest/jest setup helpers). It is forwarded to `@prisma/adapter-pg` as its
`schema` option, which sets the connection `search_path` so Prisma reads and
writes in a non-`public` PostgreSQL schema. Omit it to keep `public`.
