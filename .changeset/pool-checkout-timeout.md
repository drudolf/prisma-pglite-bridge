---
"prisma-pglite-bridge": patch
---

Honor the documented `connectionTimeoutMillis` option on `PgBridgePool`, so a
checkout queued behind an exhausted pool rejects at its deadline and cannot
later capture a released client.
