/** biome-ignore-all lint/style/noNonNullAssertion: test files only */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach } from 'vitest';
import { pushMigrations } from '../migrations.ts';
import {
  createPGliteBridge,
  type PGliteBridge,
  type PGliteBridgeOptions,
} from '../pglite-bridge.ts';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/0001_init/migration.sql'),
  'utf8',
);

interface TestOptions extends Partial<PGliteBridgeOptions> {
  /**
   * Override the SQL applied via {@link pushMigrations}. Defaults to the
   * project's `0001_init/migration.sql`. Pass `null` to skip the migration
   * step entirely (e.g. when reopening a persistent dataDir).
   */
  migrationsSql?: string | null;
}

const createTestPGliteBridge = async (options: TestOptions = {}): Promise<PGliteBridge> => {
  const pglite = options.pglite ?? new PGlite();
  const { migrationsSql, ...bridgeOptions } = options;
  const bridge = await createPGliteBridge({ ...bridgeOptions, pglite });

  if (migrationsSql !== null) {
    await pushMigrations(pglite, { sql: migrationsSql ?? MIGRATION_SQL });
  }

  return bridge;
};

type SetupTestSuiteFn = ({
  options,
  reset,
}: {
  options?: TestOptions;
  reset?: boolean;
}) => Promise<{
  prisma: PrismaClient;
  bridge: PGliteBridge;
  pglite: PGlite;
}>;

const setupTestSuite: SetupTestSuiteFn = async ({ options, reset = true } = {}) => {
  const pglite = options?.pglite ?? new PGlite();
  const bridge = await createTestPGliteBridge({ ...options, pglite });
  const prisma = new PrismaClient({ adapter: bridge.adapter });

  if (reset) {
    beforeEach(async () => {
      await bridge!.resetDb();
    });
  }

  afterAll(async () => {
    await prisma.$disconnect();
    await bridge.close();
    await pglite.close();
  });

  return { prisma, bridge, pglite };
};

export default setupTestSuite;
