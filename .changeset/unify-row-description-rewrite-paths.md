---
"prisma-pglite-bridge": patch
---

Unify the fast and slow RowDescription rewrite paths in
`BackendMessageFramer` behind a single `emitRewrittenRowDescription(buf)`
helper. Removes a redundant guard, an unsafe `as Buffer` cast, and a
dead state-reset; behavior is unchanged.
