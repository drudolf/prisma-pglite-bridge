---
"prisma-pglite-bridge": patch
---

Reject FastQuery submit-time failures at ReadyForQuery instead of settling inside submit. A Bind serialization throw (circular value, throwing `toPostgres`) or a warm-path `types.getTypeParser` throw previously rejected the promise before the recovery Sync round-tripped, clearing the submission chain while pg's active-query slot still held the query — a `release()` issued during or after that rejection then skipped the abandoned-transaction rollback, leaking the open transaction and the SessionLock (siblings blocked indefinitely). Buffering the error until the recovery Sync's ReadyForQuery keeps the chain occupied through the window, so release-time cleanup engages normally.
