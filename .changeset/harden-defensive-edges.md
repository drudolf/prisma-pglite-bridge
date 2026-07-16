---
"prisma-pglite-bridge": patch
---

Hardened three defensive edges found in review. The process-global
statement-name namespace counter now self-heals when same-process code
poisons its `Symbol.for` slot with a non-integer (previously every later
namespace was corrupted by string concatenation). A frozen or
non-writable-callback `DEALLOCATE` Submittable no longer throws after a
successful admission — eviction arming fails closed and the statement runs
unchanged. And the pool's live-slot release tolerates a missing
shared-instance counter entry instead of storing `NaN` forever.
