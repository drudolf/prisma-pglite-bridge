/** biome-ignore-all lint/style/noNonNullAssertion: test files only */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach } from 'vitest';

import {
  type CreatePgliteAdapterOptions,
  createPgliteAdapter,
  type PgliteAdapter,
} from '../create-pglite-adapter.ts';
import { pushMigrations } from '../migrations.ts';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/0001_init/migration.sql'),
  'utf8',
);

interface TestOptions extends Partial<CreatePgliteAdapterOptions> {
  /**
   * Override the SQL applied via {@link pushMigrations}. Defaults to the
   * project's `0001_init/migration.sql`. Pass `null` to skip the migration
   * step entirely (e.g. when reopening a persistent dataDir).
   */
  migrationsSql?: string | null;
}

const createTestPgliteAdapter = async (options: TestOptions = {}): Promise<PgliteAdapter> => {
  const pglite = options.pglite ?? new PGlite();
  const { migrationsSql, ...adapterOptions } = options;
  const adapter = await createPgliteAdapter({ ...adapterOptions, pglite });

  if (migrationsSql !== null) {
    await pushMigrations(adapter, { sql: migrationsSql ?? MIGRATION_SQL });
  }

  return adapter;
};

type SetupTestSuiteFn = ({
  options,
  reset,
}: {
  options?: TestOptions;
  reset?: boolean;
}) => Promise<{
  prisma: PrismaClient;
  adapter: PgliteAdapter;
  pglite: PGlite;
}>;

const setupTestSuite: SetupTestSuiteFn = async ({ options, reset = true } = {}) => {
  const pglite = options?.pglite ?? new PGlite();
  const adapter = await createTestPgliteAdapter({ ...options, pglite });
  const prisma = new PrismaClient({ adapter: adapter.adapter });

  if (reset) {
    beforeEach(async () => {
      await adapter!.resetDb();
    });
  }

  afterAll(async () => {
    await prisma.$disconnect();
    await adapter.close();
    await pglite.close();
  });

  return { prisma, adapter, pglite };
};

export default setupTestSuite;
