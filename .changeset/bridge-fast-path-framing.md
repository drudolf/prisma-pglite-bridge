---
'prisma-pglite-bridge': patch
---

Perf: BackendMessageFramer now emits whole in-chunk messages as a single
zero-copy slice instead of separate prefix + payload pushes. Restores
v0.4.1-level throughput on read-heavy paths (e.g. findMany of 100+ rows)
without giving up the streaming path for payloads that span multiple
PGlite chunks.
