---
"prisma-pglite-bridge": patch
---

Rows-mode queries (`rows: N`, pg-cursor, pg-query-stream) that error
mid-portal no longer wedge the connection on PGlite 0.5.11 and later. The
bridge now forwards the ReadyForQuery of its own recovery Sync instead of
relying on the premature one older PGlite builds emitted after an error, so
pg sees the same `ErrorResponse … ReadyForQuery` sequence on every supported
PGlite version.
