/** biome-ignore-all lint/style/noNonNullAssertion: test files only */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach } from 'vitest';

import {
  type CreatePgliteAdapterOptions,
  createPgliteAdapter,
  type PgliteAdapter,
} from '../create-pglite-adapter.ts';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/0001_init/migration.sql'),
  'utf8',
);

const createTestPgliteAdapter = (
  options: CreatePgliteAdapterOptions = {},
): Promise<PgliteAdapter> => {
  if (
    options.sql !== undefined ||
    options.migrationsPath !== undefined ||
    options.configRoot !== undefined
  ) {
    return createPgliteAdapter(options);
  }

  return createPgliteAdapter({ sql: MIGRATION_SQL, ...options });
};

type SetupTestSuiteFn = ({
  options,
  reset,
}: {
  options?: CreatePgliteAdapterOptions;
  reset?: boolean;
}) => Promise<{
  prisma: PrismaClient;
  adapter: PgliteAdapter;
}>;

const setupTestSuite: SetupTestSuiteFn = async ({ options, reset = true } = {}) => {
  const adapter = await createTestPgliteAdapter(options);
  const prisma = new PrismaClient({ adapter: adapter.adapter });

  if (reset) {
    beforeEach(async () => {
      await adapter!.resetDb();
    });
  }

  afterAll(async () => {
    await prisma.$disconnect();
    await adapter.close();
  });

  return {
    prisma,
    adapter,
  };
};

export default setupTestSuite;
