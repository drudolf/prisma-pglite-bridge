---
"prisma-pglite-bridge": patch
---

Harden snapshot capture: the internal `__tables` bookkeeping insert now binds
schema/table names as query parameters instead of interpolating them through a
hand-rolled SQL string-literal escaper, which is removed. Dynamic catalog
values now go through bind parameters or the database's own
`quote_ident()`/`quote_literal()` exclusively. No behavior change.
