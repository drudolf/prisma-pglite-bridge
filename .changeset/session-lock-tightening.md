---
'prisma-pglite-bridge': patch
---

Tighten `SessionLock` and drop dead helpers.

- `SessionLock.updateStatus` and `release` now return a `boolean`
  indicating whether ownership transitioned on that call.
- Remove unused `createBridgeId` factory; call sites use
  `Symbol('bridge')` directly.
- Remove unused `extractRfqStatus` helper — status is tracked via
  the `BackendMessageFramer.onReadyForQuery` callback.
