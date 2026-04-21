---
'prisma-pglite-bridge': patch
---

Reduce bridge backend chunk copies. When PGlite hands the framer a
standalone `Uint8Array` — `byteOffset === 0` and
`byteLength === buffer.byteLength`, so the chunk owns its full
`ArrayBuffer` — the emitted payload slice is now a zero-copy
`Buffer` view over that same backing store. Chunks that are views
into a larger buffer, or backed by a `SharedArrayBuffer`, still get
copied, so we never pin unrelated trailing bytes and never expose
shared memory the WASM runtime may still mutate.
