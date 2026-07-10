---
"prisma-pglite-bridge": patch
---

`PgBridgeClient.query` no longer crashes on config-embedded callbacks
(`query({ text, callback })`). The shape is now routed through the promise
re-entry path like positional callbacks, returning `undefined` per stock pg's
callback-mode contract; when both are supplied, the last positional callback
wins, mirroring pg's `normalizeQueryConfig`. Previously the shape threw a
synchronous `TypeError` whenever the submission chain was idle, after the
query had already been enqueued.
