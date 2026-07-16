---
"prisma-pglite-bridge": patch
---

Fail deterministically during pool-client construction when the installed
`pg` 8.x package does not expose the private internals required by the enabled
bridge features. The aggregated diagnostic replaces later query or cleanup
failures and gives deduplication guidance. The public API is unchanged.
