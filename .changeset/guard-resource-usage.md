---
'prisma-pglite-bridge': patch
---

Guard `process.resourceUsage()` when reading `processRssPeakBytes`
under `statsLevel: 'full'`. On runtimes that expose a `process`
global without `resourceUsage` (Bun, Deno, edge workers) the field
now returns `undefined` instead of throwing and taking the whole
`stats()` call down with it. `StatsFull.processRssPeakBytes` is now
typed as `number | undefined`, matching the field-level-undefined
contract documented on the other `Stats` members. Consumers already
reading this field on Node 20+ see no change — `resourceUsage()` is
present there and the value is a real number.
