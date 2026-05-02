import { beforeEach, vi } from 'vitest';

import getInstance from './bridge.ts';

vi.mock('./prisma.ts', async () => {
  const { default: getInstance } = await import('./bridge.ts');
  const { prisma } = await getInstance();
  return { prisma };
});

beforeEach(async () => {
  const { resetDb } = await getInstance();
  await resetDb();
});
