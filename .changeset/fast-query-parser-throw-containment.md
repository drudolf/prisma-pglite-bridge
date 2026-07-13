---
"prisma-pglite-bridge": patch
---

Contain type-parser failures in the FastQuery fast path. A throwing `types.getTypeParser` no longer wedges the client (the warm path recovers the already-sent Bind with a Sync; the cold path buffers the error until ReadyForQuery), and a throwing row parser no longer escapes the connection's dataRow event as an uncaughtException — all three cases now reject the query's promise, discard partial rows, and leave the client usable, matching stock pg semantics.
