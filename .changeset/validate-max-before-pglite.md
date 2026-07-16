---
"prisma-pglite-bridge": patch
---

`PGliteBridge` now validates `max` before creating its owned PGlite
instance. Previously an invalid `max` (`0`, negative, non-integer) threw the
pool's TypeError only after `new PGlite()` had already started its eager
WASM initialization, orphaning ~135 MB until garbage collection. The rejected
configuration now throws before any PGlite exists.
