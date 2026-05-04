import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';

import { PGliteBridge, pushMigrations } from '../../../index.ts';

import { seed } from './seed.ts';

interface Bridge {
  prisma: PrismaClient;
  resetDb: () => Promise<void>;
  close: () => Promise<void>;
}

let instance: Promise<Bridge> | undefined;

const createInstance = async (): Promise<Bridge> => {
  const pglite = new PGlite();
  const bridge = new PGliteBridge({ pglite });

  await pushMigrations(pglite, { configRoot: process.cwd() });

  const prisma = new PrismaClient({ adapter: bridge.adapter });
  await seed(prisma);
  await bridge.snapshotDb();

  return {
    prisma,
    resetDb: bridge.resetDb,
    close: async () => {
      await prisma.$disconnect();
      await bridge.close();
      await pglite.close();
      instance = undefined;
    },
  };
};

const getInstance = (): Promise<Bridge> => {
  if (!instance) instance = createInstance();
  return instance;
};

export default getInstance;
