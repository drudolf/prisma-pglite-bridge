---
"prisma-pglite-bridge": patch
---

Internal: the `getTypeParser` carrier shape is now declared once
(`TypesLike` in the fast-array-parser module) instead of twice — the
duplicate `FastQueryTypes` alias is gone. No public surface change.
