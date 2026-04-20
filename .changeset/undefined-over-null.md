---
'prisma-pglite-bridge': patch
---

Use `undefined` instead of `null` for absent values across bridge,
adapter, pool, and stats-collector internals. Node stream contracts
(`Error | null` callbacks, `push(null)` EOS) are unchanged.
