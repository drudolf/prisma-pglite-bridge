---
"prisma-pglite-bridge": patch
---

Expose a pg-compatible `query_timeout` default on `PgBridgePool` and `PGliteBridge`. Ordinary query deadlines now start at the public call after checkout and include time spent behind the bridge submission chain. A query that expires before bridge admission is skipped instead of executing later; an admitted query still drains internally before successors run. Pool checkout and backend cancellation remain separate concerns.
