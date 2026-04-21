---
'prisma-pglite-bridge': patch
---

Fix README drift in the `'full'` stats section. The
`processRssPeakBytes` bullet still described the old 500ms-interval
sampler; the surrounding prose claimed "all 'full'-only fields are
guaranteed defined", contradicting the `number | undefined` type
signature on runtimes without `process.resourceUsage`. Both are now
corrected: RSS reads from `process.resourceUsage().maxRSS` at
`stats()` time, and the exhaustive list of `undefined`-capable
fields is stated explicitly.
