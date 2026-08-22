import { PrismaClient } from '../../../generated/prisma/client.ts';

import { PGliteBridge, pushMigrations } from '../../../index.ts';

import { seed } from './seed.ts';

interface Bridge {
  prisma: PrismaClient;
  resetDb: () => Promise<void>;
  close: () => Promise<void>;
}

let instance: Promise<Bridge> | undefined;

const createInstance = async (): Promise<Bridge> => {
  const bridge = new PGliteBridge();

  await pushMigrations(bridge.pglite, { configRoot: process.cwd() });

  const prisma = new PrismaClient({ adapter: bridge.adapter });
  await seed(prisma);
  await bridge.snapshotDb();

  return {
    prisma,
    resetDb: bridge.resetDb,
    close: async () => {
      await prisma.$disconnect();
      await bridge.close();
      instance = undefined;
    },
  };
};

export const getInstance = (): Promise<Bridge> => {
  if (!instance) instance = createInstance();
  return instance;
};
