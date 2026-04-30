import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';

import { createPgliteAdapter, pushSchema } from '../../index.ts';

import { seed } from './seed.ts';

interface Bridge {
  prisma: PrismaClient;
  resetDb: () => Promise<void>;
  close: () => Promise<void>;
}

let instance: Promise<Bridge> | undefined;

const createInstance = async (): Promise<Bridge> => {
  const pglite = new PGlite();
  const { adapter, close, resetDb, snapshotDb } = await createPgliteAdapter({ pglite });

  await pushSchema(adapter, {
    schema: readFileSync(join(process.cwd(), 'prisma/schema.prisma'), 'utf8'),
  });

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
