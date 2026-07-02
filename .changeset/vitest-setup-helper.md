---
"prisma-pglite-bridge": minor
---

New `prisma-pglite-bridge/vitest` entry point with `setupPGliteBridge` — a
one-call Vitest setup that creates a bridge, applies migrations (or an inline
schema), runs your seed, snapshots the state, and registers
`beforeEach(resetDb)` + `afterAll(close)` hooks:

```typescript
import { PrismaClient } from '@prisma/client';
import { setupPGliteBridge } from 'prisma-pglite-bridge/vitest';

const { prisma } = await setupPGliteBridge({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  seed: async (prisma) => {
    await prisma.tenant.create({ data: { name: 'Acme' } });
  },
});
```

`vitest` becomes an optional peer dependency; only the new entry point
imports it.
