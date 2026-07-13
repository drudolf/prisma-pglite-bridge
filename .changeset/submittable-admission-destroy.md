---
"prisma-pglite-bridge": patch
---

Destroy the client connection when a Submittable's `submit()` throws at deferred admission. pg marks the query active and clears `readyForQuery` before calling `submit()`, so a throw left the client silently wedged — every later query queued forever, strictly worse than stock pg's synchronous throw. Destroying the duplex routes the error to the Submittable's `handleError` exactly once via pg's connection-error path, rejects queued successors instead of hanging them, and lets the pool evict the dead client.
