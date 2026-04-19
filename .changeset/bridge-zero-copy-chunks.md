---
'prisma-pglite-bridge': patch
---

Reduce bridge backend chunk copies. When PGlite hands the framer a
standalone `Uint8Array` (one that owns its full backing store), the
emitted payload slice is now a zero-copy `Buffer` view over the same
`ArrayBuffer`. Chunks that are views into a larger buffer still get
copied, so we never pin unrelated trailing bytes.
