---
"prisma-pglite-bridge": patch
---

Remove the zero-copy emit branch from the backend framer. The branch never
fired on real PGlite chunks (raw-stream chunks are views into the reused WASM
flush buffer, never standalone allocations), and had it ever fired it would
have emitted Buffer views aliasing memory the producer overwrites on the next
flush — silent data corruption. The framer now always emits a defensive copy;
production copy counts are unchanged.
