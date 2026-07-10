---
"prisma-pglite-bridge": patch
---

Internal type-safety cleanup in `PgBridgeClient`: the Submittable probe is
a named type guard, the constructor validates its options via narrowing
instead of a placeholder cast, the fast-path eligibility check narrows its
inputs naturally, and the last `any` in the codebase is gone. No behavior
change.
