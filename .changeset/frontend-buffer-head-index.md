---
'prisma-pglite-bridge': patch
---

Avoid O(n) Array.shift() in FrontendMessageBuffer.

Replace repeated `chunks.shift()` calls with a `headIndex` cursor
plus periodic compaction. Drained chunks are sliced off once they
exceed a threshold, keeping the backing array bounded without
re-indexing on every consume. `readInt32BE` also gains a fast
path for the common case where all four bytes sit in the head
chunk.
