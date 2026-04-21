---
'prisma-pglite-bridge': patch
---

Export the `StatsBasic` and `StatsFull` variant types alongside the
existing discriminated-union `Stats`. Consumers writing helpers that
accept a specific level (`(s: StatsFull) => ...`) no longer have to
widen through `Stats` or re-declare the interfaces locally.
