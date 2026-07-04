---
"prisma-pglite-bridge": patch
---

Docs: correct the `createBridgeTest({ scope: 'test' })` speedup claim.
Measured, it is several times faster per test (~5x on both Apple
Silicon and x86, and far more predictable) rather than "an order of
magnitude" — the earlier figure conflated the one-time WASM compile.
Adds a reproducible per-test isolation-cost benchmark
(`pnpm bench:isolation`) with committed two-machine reference numbers,
and updates the README, cookbook, and BENCHMARK docs to match.
