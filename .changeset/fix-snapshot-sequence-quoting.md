---
"prisma-pglite-bridge": patch
---

Fix `resetDb` failing with `relation "..._id_seq" does not exist` when a
schema uses `SERIAL` / `@default(autoincrement())` on a mixed-case table.
`snapshotDb` captured sequence names without `quote_ident`, so the
`setval` regclass argument was case-folded to lowercase on reset.
