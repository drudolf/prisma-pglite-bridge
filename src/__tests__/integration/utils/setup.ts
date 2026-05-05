import { beforeEach, vi } from 'vitest';

import { getInstance } from './bridge.ts';

// Integration tests import `prisma` from './prisma.ts' as if it were a
// regular PrismaClient. This swap rewires that import at test load time
// to the bridge-backed singleton built in bridge.ts, so every test file
// shares one client wired through PGliteBridge. Without it, each file
// would instantiate its own bypass-the-bridge client.
vi.mock('./prisma.ts', async () => {
  const { getInstance } = await import('./bridge.ts');
  const { prisma } = await getInstance();
  return { prisma };
});

beforeEach(async () => {
  const { resetDb } = await getInstance();
  await resetDb();
});
