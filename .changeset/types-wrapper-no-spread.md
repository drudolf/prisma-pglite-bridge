---
"prisma-pglite-bridge": patch
---

Stop spreading caller-supplied `types` objects when wrapping array parsers:
unrelated own getters are no longer read (or able to throw) during
`query()`; the wrapper exposes only `getTypeParser`.
