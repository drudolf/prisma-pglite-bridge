import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';

import { createPgliteAdapter, pushMigrations } from '../../index.ts';

import { seed } from './seed.ts';

interface Bridge {
  prisma: PrismaClient;
  resetDb: () => Promise<void>;
  close: () => Promise<void>;
}

let instance: Promise<Bridge> | undefined;

const createInstance = async (): Promise<Bridge> => {
  const pglite = new PGlite();
  const pgliteAdapter = await createPgliteAdapter({ pglite });
  const { adapter, close, resetDb, snapshotDb } = pgliteAdapter;

  await pushMigrations(pgliteAdapter, { configRoot: process.cwd() });

  const prisma = new PrismaClient({ adapter });
  await seed(prisma);
  await snapshotDb();

  return {
    prisma,
    resetDb,
    close: async () => {
      await prisma.$disconnect();
      await close();
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
