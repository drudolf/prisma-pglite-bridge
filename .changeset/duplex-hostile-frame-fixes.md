---
"prisma-pglite-bridge": patch
---

Fix two hostile-frame defects in the backend framing layer, found by the
new property-based test suite. A Z-typed frame with a declared length ≠ 5
could be reclassified as ReadyForQuery mid-payload when a chunk boundary
left exactly one payload byte remaining, corrupting the output stream
with stale held-RFQ bytes and firing a spurious `onReadyForQuery`; frame
classification is now latched once at header decode. RowDescription
fieldCount was read signed in `rewriteRowDescriptionInPlace` but unsigned
in `rowDescriptionNeedsRewrite`, letting the rewrite gate and worker
disagree on frames declaring ≥ 0x8000 fields; both now read unsigned.
Neither defect is reachable from a well-behaved backend.
