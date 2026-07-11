---
"prisma-pglite-bridge": patch
---

Close the dangling implicit transaction when a pool client abandons a
suspended pg-cursor portal: its release now manufactures the terminating
Sync the client never sent, before the session lock is released. Without
it, the next sibling query inherited the open implicit transaction and
recorded ReadyForQuery `T` — so the sibling's perfectly clean release
fired a misattributed `PGliteBridgeAbandonedTransactionWarning` and
enqueued a needless ROLLBACK that could race pool teardown into a
dead-WASM event-loop spin.
