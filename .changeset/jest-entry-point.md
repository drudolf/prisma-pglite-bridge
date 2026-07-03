---
"prisma-pglite-bridge": minor
---

New `prisma-pglite-bridge/jest` entry point — the Jest counterpart to
`prisma-pglite-bridge/vitest`'s `setupPGliteBridge`:

```typescript
import { PrismaClient } from '@prisma/client';
import { setupPGliteBridge } from 'prisma-pglite-bridge/jest';

const { prisma } = await setupPGliteBridge({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  seed: async (prisma) => {
    await prisma.tenant.create({ data: { name: 'Acme' } });
  },
});

test('starts from the seeded snapshot', async () => {
  expect(await prisma.tenant.count()).toBe(1);
});
```

Same options and behavior as the vitest helper — one call sets up the
bridge, schema, seed, and snapshot, and by default registers
`beforeEach(resetDb)` + `afterAll(close)` — wired to Jest's hooks via
`@jest/globals` (a new optional peer dependency). Requires Jest's native
ESM mode so the top-level `await` resolves before the suite runs. Jest has
no fixture (`test.extend`) equivalent, so there is no `createBridgeTest` on
this entry; the hook-based helper is the whole surface.
