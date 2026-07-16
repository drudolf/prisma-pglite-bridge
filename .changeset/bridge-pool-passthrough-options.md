---
"prisma-pglite-bridge": patch
---

Declare `connectionTimeoutMillis`, `idleTimeoutMillis`, and `fastQueryPath`
on `PGliteBridgeOptions`. The bridge constructor already forwarded them to
its pool at runtime via the options spread, but TypeScript users could not
configure them without a cast. Type-surface fix only; runtime behavior is
unchanged.
