---
'prisma-pglite-bridge': patch
---

Fix: BackendMessageFramer fast path now requires `messageLength === 5`
before treating a 0x5a-typed frame as ReadyForQuery, mirroring the slow
path's guard. A non-conforming 0x5a frame (length ≠ 5) previously
triggered spurious RFQ emission and dropped its payload; it is now
forwarded verbatim.
