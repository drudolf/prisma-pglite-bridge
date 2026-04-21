import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import setupTestSuite from './__tests__/adapter.ts';
import { createTempDir, removeTempDir } from './__tests__/file-system.ts';
import { createPgliteAdapter } from './create-pglite-adapter.ts';

const { prisma, adapter } = await setupTestSuite({
  options: { statsLevel: 1 },
});

type CreatePgliteAdapterModule = typeof import('./create-pglite-adapter.ts');

interface MockPglite {
  exec: Mock;
  query: Mock;
  waitReady: Promise<void>;
}

const createMockPglite = ({
  exec,
  query = vi.fn().mockResolvedValue({ rows: [] }),
}: {
  exec: Mock;
  query?: Mock;
}): MockPglite => ({
  exec,
  query,
  waitReady: Promise.resolve(),
});

const loadCreatePgliteAdapterWithMocks = async ({
  poolEnd = vi.fn().mockResolvedValue(undefined),
  getMigrationSQL = vi
    .fn()
    .mockImplementation(async (options: { sql?: string }) => options.sql ?? 'BROKEN SQL'),
}: {
  poolEnd?: Mock;
  getMigrationSQL?: Mock;
} = {}): Promise<CreatePgliteAdapterModule> => {
  vi.resetModules();
  vi.doMock('./create-pool.ts', () => ({
    createPool: vi.fn().mockResolvedValue({
      pool: { end: poolEnd },
      adapterId: Symbol('mock'),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  }));
  vi.doMock('./utils/migrations.ts', async () => {
    const actual =
      await vi.importActual<typeof import('./utils/migrations.ts')>('./utils/migrations.ts');
    return { ...actual, getMigrationSQL };
  });
  return import('./create-pglite-adapter.ts');
};

afterEach(() => {
  vi.doUnmock('./create-pool.ts');
  vi.doUnmock('./utils/migrations.ts');
  vi.resetModules();
});

describe('createPgliteAdapter', () => {
  it('rejects invalid stats levels', async () => {
    const pglite = new PGlite();
    try {
      await expect(
        createPgliteAdapter({ pglite, sql: 'SELECT 1', statsLevel: 3 as 2 }),
      ).rejects.toThrow('statsLevel must be 0, 1, or 2; got 3');
    } finally {
      await pglite.close();
    }
  });

  it('returns telemetry when stats are enabled', async () => {
    const stats = await adapter.stats();

    expect(stats).toBeDefined();
    expect(stats?.statsLevel).toBe(1);
    expect(stats?.schemaSetupMs).toBeDefined();
  });

  it('returns undefined stats when statsLevel is 0', async () => {
    const pglite = new PGlite();
    const created = await createPgliteAdapter({ pglite, sql: 'SELECT 1' });

    try {
      await expect(created.stats()).resolves.toBeUndefined();
    } finally {
      await created.close();
      await pglite.close();
    }
  });

  it('resetDb clears user data', async () => {
    await prisma.tenant.create({
      data: { id: 'tenant-reset', name: 'Reset Tenant', slug: 'tenant-reset' },
    });

    await adapter.resetDb();

    await expect(prisma.tenant.count()).resolves.toBe(0);
  });

  it('reuses an initialized persistent dataDir when migrations are not re-applied', async () => {
    const { parent, path: dataDir } = createTempDir('adapter-data');

    const firstPglite = new PGlite(dataDir);
    const first = await createPgliteAdapter({
      pglite: firstPglite,
      sql: 'CREATE TABLE IF NOT EXISTS "Tenant" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT NOT NULL)',
      statsLevel: 1,
    });
    const firstPrisma = new PrismaClient({ adapter: first.adapter });

    await firstPrisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "slug") VALUES ('tenant-persist', 'Persistent Tenant', 'tenant-persist')`,
    );

    await firstPrisma.$disconnect();
    await first.close();
    await firstPglite.close();

    const secondPglite = new PGlite(dataDir);
    const second = await createPgliteAdapter({ pglite: secondPglite, statsLevel: 1 });
    const secondPrisma = new PrismaClient({ adapter: second.adapter });

    try {
      const { rows } = await secondPglite.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM "Tenant"',
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await secondPrisma.$disconnect();
      await second.close();
      await secondPglite.close();
    }

    removeTempDir(parent);
  });

  it('snapshotDb restores the snapped state on resetDb', async () => {
    await prisma.tenant.create({
      data: { id: 'tenant-snap', name: 'Snapshot Tenant', slug: 'tenant-snap' },
    });

    await adapter.snapshotDb();

    await prisma.tenant.create({
      data: { id: 'tenant-extra', name: 'Extra Tenant', slug: 'tenant-extra' },
    });

    await adapter.resetDb();

    await expect(prisma.tenant.findMany({ orderBy: { id: 'asc' } })).resolves.toMatchObject([
      { id: 'tenant-snap', name: 'Snapshot Tenant', slug: 'tenant-snap' },
    ]);
  });

  it('resetSnapshot discards the current snapshot', async () => {
    await prisma.tenant.create({
      data: { id: 'tenant-drop', name: 'Drop Snapshot', slug: 'tenant-drop' },
    });

    await adapter.snapshotDb();
    await adapter.resetSnapshot();

    await prisma.tenant.create({
      data: { id: 'tenant-after-drop', name: 'After Drop', slug: 'tenant-after-drop' },
    });

    await adapter.resetDb();

    await expect(prisma.tenant.count()).resolves.toBe(0);
  });

  it('wraps migration failures with a descriptive error', async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error('migration failed'));
    const pglite = createMockPglite({ exec });
    const { createPgliteAdapter } = await loadCreatePgliteAdapterWithMocks();

    await expect(
      createPgliteAdapter({
        pglite: pglite as unknown as PGlite,
        migrationsPath: '/tmp/migrations',
      }),
    ).rejects.toThrow(
      'Failed to apply schema SQL to PGlite. Check your schema or migration files.',
    );
    expect(exec.mock.calls).toEqual([['BROKEN SQL']]);
  });

  it('applies migration SQL when a migrationsPath is provided', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const pglite = createMockPglite({ exec });
    const { createPgliteAdapter } = await loadCreatePgliteAdapterWithMocks({
      getMigrationSQL: vi.fn().mockResolvedValue('SELECT 1'),
    });

    const created = await createPgliteAdapter({
      pglite: pglite as unknown as PGlite,
      migrationsPath: '/tmp/migrations',
    });

    expect(exec.mock.calls).toEqual([['SELECT 1']]);

    await created.close();
  });

  it('skips migration application when no migration config is provided', async () => {
    const exec = vi.fn().mockResolvedValue(undefined);
    const pglite = createMockPglite({ exec });
    const { createPgliteAdapter } = await loadCreatePgliteAdapterWithMocks();

    const created = await createPgliteAdapter({ pglite: pglite as unknown as PGlite });

    expect(exec.mock.calls).toEqual([]);

    await created.close();
  });

  it('wraps explicit sql failures with a descriptive error', async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error('bad sql'));
    const pglite = createMockPglite({ exec });
    const { createPgliteAdapter } = await loadCreatePgliteAdapterWithMocks();

    await expect(
      createPgliteAdapter({ pglite: pglite as unknown as PGlite, sql: 'SELECT 1' }),
    ).rejects.toThrow(
      'Failed to apply schema SQL to PGlite. Check your schema or migration files.',
    );
    expect(exec.mock.calls).toEqual([['SELECT 1']]);
  });

  it('close is idempotent while shutdown is already in progress', async () => {
    let releaseEnd: (() => void) | undefined;
    const poolEnd = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseEnd = resolve;
        }),
    );
    const exec = vi.fn().mockResolvedValue(undefined);
    const pglite = createMockPglite({ exec });
    const { createPgliteAdapter } = await loadCreatePgliteAdapterWithMocks({ poolEnd });
    const created = await createPgliteAdapter({
      pglite: pglite as unknown as PGlite,
      sql: 'SELECT 1',
    });

    const closingA = created.close();
    const closingB = created.close();
    releaseEnd?.();

    await Promise.all([closingA, closingB]);

    expect(poolEnd).toHaveBeenCalledTimes(1);
  });
});
