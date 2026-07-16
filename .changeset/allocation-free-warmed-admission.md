---
"prisma-pglite-bridge": patch
---

Remove transient per-query allocations from warmed prepared-statement admission by passing the already-captured SQL text directly to the internal statement-name generator and checking fast-query disqualifiers directly. The public API is unchanged; the internal generator remains unexported.
