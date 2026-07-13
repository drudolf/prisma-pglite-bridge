---
"prisma-pglite-bridge": patch
---

Decode escaped and non-ASCII `DEALLOCATE` identifiers. The statement-cache eviction detector is now a bounded scanner instead of a regex: quoted identifiers with doubled-quote escapes (`DEALLOCATE "a""b"`) and non-ASCII identifiers (`DEALLOCATE MÜNZE`, folded ASCII-only to `mÜnze` exactly as PostgreSQL folds it) now evict the right cache entry instead of leaving that name failing with error 26000, and `DEALLOCATE PREPARE` disambiguation, exact long spellings, and `$`-identifiers are pinned by an exhaustive grammar table. Undecodable text still fails closed — the SQL runs unchanged and no cache entry is ever guessed at. Comments, multi-statement text, and `U&"..."` syntax remain outside the supported subset (documented).
