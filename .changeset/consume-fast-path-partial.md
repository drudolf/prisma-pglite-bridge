---
'prisma-pglite-bridge': patch
---

Fix `FrontendMessageBuffer.consume` fast-path condition. The guard
`headRemaining >= length && length === headRemaining` reduced to
`length === headRemaining`, so the zero-copy subarray path only
fired on exact-match consumes. Partial consumes from a larger head
chunk now also return a zero-copy view, removing an unnecessary
allocation on the Prisma hot path when multiple backend messages
arrive in a single chunk.
