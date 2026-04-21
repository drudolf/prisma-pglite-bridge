---
'prisma-pglite-bridge': patch
---

Fix session-lock poisoning when a bridge is destroyed while waiting.

`PGliteBridge._destroy` now calls `SessionLock.cancel()` instead of
`release()`. Previously, a bridge torn down while queued in
`waitQueue` stayed queued and was later granted ownership by
`drainWaitQueue`, starving every subsequent waiter. `cancel()` also
rejects the pending `acquire()` promise so the destroy error
propagates to queued write callbacks.
