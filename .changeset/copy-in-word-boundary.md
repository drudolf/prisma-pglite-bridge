---
"prisma-pglite-bridge": patch
---

Fix three word-boundary defects in the `COPY … FROM STDIN` sniffer,
found by a new property-based suite with an 88-cell characterization
table cross-checked against real PGlite statement splitting. The
scanner opened an E-string at `e'`/`E'` and a dollar quote at `$tag$`
without requiring the PostgreSQL word boundary, so text like
`SELECT 'a' LIKE'\'; COPY t FROM STDIN` or
`SELECT 1 AS a$tag$; COPY t FROM STDIN` — two statements to PostgreSQL —
was misread as one and classified `not-copy-in`, forwarding a copy-in to
PGlite (WASM `exit(1)`, instance death). The opener now requires that
the preceding character cannot continue an identifier (ASCII word
chars, `$`, and high-bit bytes all count as glue), the dollar-tag rule
rejects digits-only pseudo-tags (`$1$` is a parameter, not a
delimiter), and literal-only statements (`E'x';…`) now count toward the
statement split instead of vanishing. Every changed verdict moves in
the fail-closed direction.
