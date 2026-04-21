---
'prisma-pglite-bridge': minor
---

Replace the sampled 500ms RSS interval with a kernel-tracked
`process.resourceUsage().maxRSS` read at snapshot and freeze time.
`processRssPeakBytes` now reports the true high-water mark rather
than a lower-bound estimate, and `'full'`-level adapters no longer
spin up a per-adapter interval timer. The `AdapterStats.stop()`
method is removed — there is no longer any timer to clear.

The field continues to reflect the whole Node process, not just
one adapter; see the `Stats` JSDoc for how to interpret it.
