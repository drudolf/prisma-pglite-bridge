import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import type { Mock } from 'vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import setupTestSuite from './__tests__/adapter.ts';
import { createTempDir, removeTempDir } from './__tests__/file-system.ts';
import { createMockPglite } from './__tests__/mocks.ts';
import { createPgliteAdapter, emitAdapterLeakWarning } from './create-pglite-adapter.ts';
import { pushMigrations } from './migrations.ts';

const { pglite, prisma, adapter } = await setupTestSuite({
  options: { statsLevel: 'basic' },
});

type CreatePgliteAdapterModule = typeof import('./create-pglite-adapter.ts');

const loadCreatePgliteAdapterWithMocks = async ({
  poolEnd = vi.fn().mockResolvedValue(undefined),
  prismaPg = vi.fn().mockImplementation(function MockPrismaPg() {
    return { mocked: true };
  }),
}: {
  poolEnd?: Mock;
  prismaPg?: Mock;
} = {}): Promise<{
  createPool: Mock;
  module: CreatePgliteAdapterModule;
  pool: { end: Mock };
  prismaPg: Mock;
}> => {
  vi.resetModules();
  const pool = { end: poolEnd };
  const createPool = vi.fn().mockResolvedValue({
    pool,
    adapterId: Symbol('mock'),
    close: vi.fn().mockResolvedValue(undefined),
  });
  vi.doMock('./create-pool.ts', () => ({
    createPool,
  }));
  vi.doMock('@prisma/adapter-pg', () => ({
    PrismaPg: prismaPg,
  }));
  return { createPool, module: await import('./create-pglite-adapter.ts'), pool, prismaPg };
};

afterEach(() => {
  vi.doUnmock('./create-pool.ts');
  vi.doUnmock('@prisma/adapter-pg');
  vi.resetModules();
});

describe('createPgliteAdapter', () => {
  it('rejects invalid stats levels', async () => {
    await expect(
      createPgliteAdapter({
        pglite,
        statsLevel: 'invalid' as 'basic',
      }),
    ).rejects.toThrow(`statsLevel must be 'off', 'basic', or 'full'; got invalid`);
  });

  it('returns telemetry when stats are enabled', async () => {
    const stats = await adapter.stats();

    expect(stats).toBeDefined();
    expect(stats?.statsLevel).toBe('basic');
  });

  it(`returns undefined stats when statsLevel is 'off'`, async () => {
    const { close, stats } = await createPgliteAdapter({ pglite });
    await expect(stats()).resolves.toBeUndefined();
    close();
  });

  it('exposes the underlying pglite instance', () => {
    expect(adapter.pglite).toBe(pglite);
  });

  it('resetDb clears user data', async () => {
    await prisma.tenant.create({
      data: { id: 'tenant-reset', name: 'Reset Tenant', slug: 'tenant-reset' },
    });

    await adapter.resetDb();

    await expect(prisma.tenant.count()).resolves.toBe(0);
  });

  it('reuses an initialized persistent dataDir without re-applying migrations', async () => {
    const { parent, path: dataDir } = createTempDir('adapter-data');

    const firstPglite = new PGlite(dataDir);
    const first = await createPgliteAdapter({ pglite: firstPglite, statsLevel: 'basic' });
    await pushMigrations(first, {
      sql: 'CREATE TABLE IF NOT EXISTS "Tenant" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT NOT NULL)',
    });
    const firstPrisma = new PrismaClient({ adapter: first.adapter });

    await firstPrisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "slug") VALUES ('tenant-persist', 'Persistent Tenant', 'tenant-persist')`,
    );

    await firstPrisma.$disconnect();
    await first.close();
    await firstPglite.close();

    const secondPglite = new PGlite(dataDir);
    const second = await createPgliteAdapter({ pglite: secondPglite, statsLevel: 'basic' });
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

  it('close is idempotent while shutdown is already in progress', async () => {
    let releaseEnd: (() => void) | undefined;
    const poolEnd = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseEnd = resolve;
        }),
    );
    const pglite = createMockPglite();
    const { module } = await loadCreatePgliteAdapterWithMocks({ poolEnd });
    const { createPgliteAdapter } = module;
    const created = await createPgliteAdapter({ pglite });

    const closingA = created.close();
    const closingB = created.close();
    releaseEnd?.();

    await Promise.all([closingA, closingB]);

    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it('forwards syncToFs to createPool', async () => {
    const pglite = createMockPglite();
    const { createPool, module, pool, prismaPg } = await loadCreatePgliteAdapterWithMocks();
    const { createPgliteAdapter } = module;

    const created = await createPgliteAdapter({ pglite, syncToFs: false });

    expect(createPool).toHaveBeenCalledWith(
      expect.objectContaining({
        pglite,
        syncToFs: false,
      }),
    );
    expect(prismaPg).toHaveBeenCalledWith(pool);
    expect(created.adapter).toEqual({ mocked: true });

    await created.close();
  });

  it('emitAdapterLeakWarning emits a typed process warning', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    try {
      emitAdapterLeakWarning();
      expect(spy).toHaveBeenCalledTimes(1);
      const [message, options] = spy.mock.calls[0] ?? [];
      expect(String(message)).toContain('garbage-collected');
      expect(String(message)).toContain('close()');
      expect(options).toEqual({ type: 'PgliteAdapterLeakWarning' });
    } finally {
      spy.mockRestore();
    }
  });

  it('registers the adapter for leak detection and unregisters on close', async () => {
    const registerSpy = vi.spyOn(FinalizationRegistry.prototype, 'register');
    const unregisterSpy = vi.spyOn(FinalizationRegistry.prototype, 'unregister');
    try {
      const pglite = createMockPglite();
      const { module } = await loadCreatePgliteAdapterWithMocks();
      const { createPgliteAdapter } = module;
      const created = await createPgliteAdapter({ pglite });

      expect(registerSpy).toHaveBeenCalled();
      const registeredToken = registerSpy.mock.calls.at(-1)?.[2];
      expect(registeredToken).toBeDefined();

      await created.close();

      expect(unregisterSpy).toHaveBeenCalledWith(registeredToken);
    } finally {
      registerSpy.mockRestore();
      unregisterSpy.mockRestore();
    }
  });
});
