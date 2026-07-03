---
"prisma-pglite-bridge": minor
---

New `createBridgeTest` in `prisma-pglite-bridge/vitest` — a
test-context (fixture) variant of `setupPGliteBridge` built on
`test.extend`:

```typescript
import { PrismaClient } from '@prisma/client';
import { createBridgeTest } from 'prisma-pglite-bridge/vitest';

const test = createBridgeTest({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  seed: async (prisma) => {
    await prisma.tenant.create({ data: { name: 'Acme' } });
  },
});

test('starts from the seeded snapshot', async ({ prisma }) => {
  expect(await prisma.tenant.count()).toBe(1);
});
```

Tests declare what they need (`{ prisma, bridge }`, fully typed); every
test taking `prisma` starts from the seeded snapshot; teardown is
sequenced by vitest. The `scope` option spans the whole
isolation/speed dial: `'file'` (default) — one bridge per test file;
`'worker'` — one warm bridge across all files a worker runs, amortizing
the WASM cold start, migrations, and seed per worker with vitest's
default isolation left ON (previously this required `isolate: false`);
`'test'` — a fresh bridge per test, the only configuration where
`test.concurrent` is safe. The optional `vitest` peer floor moves to
`^3.2.0` (fixture scopes).
