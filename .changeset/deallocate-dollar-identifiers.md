---
"prisma-pglite-bridge": patch
---

Detect `$` in unquoted `DEALLOCATE` identifiers (valid in PostgreSQL past the first character), so deallocating a statement named e.g. `dollar$statement` evicts the client-side plan caches instead of failing the statement's next execution with error 26000.
