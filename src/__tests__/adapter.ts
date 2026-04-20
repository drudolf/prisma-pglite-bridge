import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import type { CreatePgliteAdapterOptions } from '../create-pglite-adapter.ts';
import { createPgliteAdapter as createRawPgliteAdapter } from '../create-pglite-adapter.ts';

type TestPgliteAdapterResult = Awaited<ReturnType<typeof createRawPgliteAdapter>>;
const TEST_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/0001_init/migration.sql'),
  'utf8',
);

export const createTestPgliteAdapter = (
  options: CreatePgliteAdapterOptions = {},
): ReturnType<typeof createRawPgliteAdapter> => {
  if (
    options.sql !== undefined ||
    options.migrationsPath !== undefined ||
    options.configRoot !== undefined
  ) {
    return createRawPgliteAdapter(options);
  }

  return createRawPgliteAdapter({ sql: TEST_SQL, ...options });
};

export const settleAsync = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

export const createTempDataDir = (): string => mkdtempSync(join(tmpdir(), 'prisma-pglite-bridge-'));

export const withTempDataDir = async (fn: (dataDir: string) => Promise<void>): Promise<void> => {
  const dataDir = createTempDataDir();
  try {
    await fn(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

export const withAdapter = async (
  opts: CreatePgliteAdapterOptions,
  fn: (result: TestPgliteAdapterResult) => Promise<void>,
): Promise<void> => {
  const result = await createTestPgliteAdapter(opts);
  try {
    await fn(result);
  } finally {
    await result.close();
  }
};

export const withPrismaAdapter = async (
  opts: CreatePgliteAdapterOptions,
  fn: (prismaClient: PrismaClient, result: TestPgliteAdapterResult) => Promise<void>,
): Promise<void> => {
  const result = await createTestPgliteAdapter(opts);
  const prismaClient = new PrismaClient({ adapter: result.adapter });
  try {
    await fn(prismaClient, result);
  } finally {
    await prismaClient.$disconnect();
    await result.close();
    await settleAsync();
  }
};

interface SharedPrismaAdapterOptions {
  adapterOptions?: CreatePgliteAdapterOptions;
  resetBeforeEach?: boolean;
  settleAfterClose?: boolean;
}

interface SharedPrismaAdapterHandle {
  prisma(): PrismaClient;
  adapter(): TestPgliteAdapterResult;
}

export const setupSharedPrismaAdapter = (
  options: SharedPrismaAdapterOptions = {},
): SharedPrismaAdapterHandle => {
  let result: TestPgliteAdapterResult | undefined;
  let prisma: PrismaClient | undefined;

  beforeAll(async () => {
    result = await createTestPgliteAdapter(options.adapterOptions);
    prisma = new PrismaClient({ adapter: result.adapter });
  });

  if (options.resetBeforeEach ?? true) {
    beforeEach(async () => {
      if (!result) throw new Error('shared adapter accessed before beforeAll');
      await result.resetDb();
    });
  }

  afterAll(async () => {
    await prisma?.$disconnect();
    await result?.close();
    if (options.settleAfterClose ?? true) await settleAsync();
    prisma = undefined;
    result = undefined;
  });

  return {
    prisma(): PrismaClient {
      if (!prisma) throw new Error('shared adapter accessed before beforeAll');
      return prisma;
    },
    adapter(): TestPgliteAdapterResult {
      if (!result) throw new Error('shared adapter accessed before beforeAll');
      return result;
    },
  };
};

export const setupSharedAdapter = (
  options: SharedPrismaAdapterOptions = {},
): (() => TestPgliteAdapterResult) => {
  let result: TestPgliteAdapterResult | undefined;

  beforeAll(async () => {
    result = await createTestPgliteAdapter(options.adapterOptions);
  });

  if (options.resetBeforeEach ?? true) {
    beforeEach(async () => {
      if (!result) throw new Error('shared adapter accessed before beforeAll');
      await result.resetDb();
    });
  }

  afterAll(async () => {
    await result?.close();
    if (options.settleAfterClose ?? true) await settleAsync();
    result = undefined;
  });

  return (): TestPgliteAdapterResult => {
    if (!result) throw new Error('shared adapter accessed before beforeAll');
    return result;
  };
};
