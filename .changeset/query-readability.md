---
"prisma-pglite-bridge": patch
---

Internal: refactor `PgBridgeClient.query()` for readability — extract the
callback-form handling into `#dispatchCallbackForm`, give the submission-chain
locals intent-revealing names, and compute the DEALLOCATE-tap promise without
re-assignment. No behavior change.
