---
'prisma-pglite-bridge': patch
---

Skip stats-related bookkeeping on the query hot path at `statsLevel:
0`. `hrtime` reads, `recordLockWait`, and `recordQuery` are now
gated behind a single null-collector branch, and the in-band
`ErrorResponse` scan runs inline over each response chunk instead of
buffering all chunks and concatenating them for the detection pass.
