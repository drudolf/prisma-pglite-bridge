---
"prisma-pglite-bridge": patch
---

Internal: dispatch Submittable and FastQuery pool queries through pg's real
`query` overload instead of an `as unknown as` view, and narrow the shared
stock-query forwarder to an honest single signature. This removes the last
type-erasing cast from the pool's `query()` path. No behavior change.
