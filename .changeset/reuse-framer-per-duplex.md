---
"prisma-pglite-bridge": patch
---

Allocation hygiene on the duplex hot path: each duplex now reuses one
backend-message framer (reset per protocol call) instead of allocating a
framer, two scratch buffers, four closures, and two options objects per
query, and the EQP pipeline array is cleared in place instead of reallocated.
No latency claims — the change removes ~10 short-lived allocations per query.

Hardening shipped with it: PGlite retains the `onRawData` callback internally
after `execProtocolRawStream` returns, so the duplex now drops any
out-of-call invocation of it instead of pushing stray bytes into the client
stream (previously such bytes could reach a stale framer and corrupt the
connection).
