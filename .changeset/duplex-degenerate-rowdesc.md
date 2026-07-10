---
"prisma-pglite-bridge": patch
---

Pass degenerate RowDescription frames through the backend framer untouched. A protocol-invalid RowDescription shorter than 7 bytes (no room for the field count) that spanned chunk boundaries hit an unguarded field-count read in the "char"-widening rewrite and tore the connection down with a `RangeError`; such frames now pass through unmodified. Only reachable from a misbehaving backend — PGlite does not emit such frames.
