---
"prisma-pglite-bridge": patch
---

Internal conventions sweep: the three `process.emitWarning` type strings are
typo-proofed by a `BridgeWarningType` union, the DEALLOCATE decoder's
identifier scanners use `charAt` instead of index casts, the callback
discovery uses one `isQueryCallback` type predicate instead of two inline
casts, `SessionLock.hold()`'s deprecation names its removal target (2.0.0),
and a once-called schema helper is inlined. No behavior change.
