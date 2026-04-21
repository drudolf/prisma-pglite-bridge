---
"prisma-pglite-bridge": patch
---

Declare `@prisma/config` as an optional peer dependency. It is only
needed when migration discovery reads from `prisma.config.ts`.
