---
"prisma-pglite-bridge": patch
---

Fail deterministically during pool-client construction when the installed
`pg` 8.x package does not expose the private internals required by the enabled
bridge features. The aggregated diagnostic replaces later query or cleanup
failures and gives deduplication and version-floor guidance. The public API
is unchanged.

`pg` 8.16.3 (the `@prisma/adapter-pg` floor) is verified compatible: the
check accepts both the `pg` <= 8.16 internal layout (own `queryQueue`, plain
`activeQuery`) and the `pg` >= 8.17 layout (`_getActiveQuery()`), and the
in-flight-query read now follows the same two layouts instead of the
never-shipped `_activeQuery`-only shape.
