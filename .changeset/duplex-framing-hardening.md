---
"prisma-pglite-bridge": patch
---

Backend-framer hardening and allocation hygiene on the duplex hot path:

- The framer always emits defensive copies now. The former zero-copy branch never fired on real PGlite chunks, and had it ever fired it would have emitted Buffer views aliasing memory the producer overwrites on the next flush — silent data corruption. Production copy counts are unchanged.
- Each duplex reuses one backend framer (reset per protocol call) instead of allocating a framer, scratch buffers, and closures per query — ~10 fewer short-lived allocations per query. Hardening shipped with it: PGlite retains the `onRawData` callback after `execProtocolRawStream` returns, so out-of-call invocations are now dropped instead of pushing stray bytes through a stale framer into the client stream.
- The RowDescription "char"-widening rewrite runs in a single scan (the redundant needs-rewrite pre-check is gone), and a protocol-invalid RowDescription shorter than 7 bytes now passes through untouched instead of tearing the connection down with a `RangeError`. Only reachable from a misbehaving backend — PGlite emits neither.
