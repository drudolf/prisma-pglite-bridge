---
'prisma-pglite-bridge': patch
---

Stream backend protocol framing instead of buffering full responses.
A new `BackendMessageFramer` parses PGlite's wire-protocol output
chunk-by-chunk and pushes payload bytes downstream as they arrive,
suppressing intermediate `ReadyForQuery` frames inline. Previously
the bridge concatenated every chunk for a query and post-processed
the whole buffer, which scaled with response size. Large multi-row
reads (e.g. `findMany`) now hold only the active frame in memory.
