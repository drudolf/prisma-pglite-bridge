/** biome-ignore-all lint/style/noNonNullAssertion: test files only */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, removeTempDir } from '../__tests__/file-system.ts';
import { createMockPGlite } from '../__tests__/mocks.ts';
import { pushMigrations } from '../schema/migrations.ts';
import type { PGliteBridgeConfig } from './index.ts';
import { emitBridgeLeakWarning, PGliteBridge } from './index.ts';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/0001_init/migration.sql'),
  'utf8',
);

const createReadyPGlite = async (dataDir?: string): Promise<PGlite> => {
  const pglite = dataDir === undefined ? new PGlite() : new PGlite(dataDir);
  await pglite.waitReady;
  return pglite;
};

const setupSuite = async (
  options: Partial<PGliteBridgeConfig> = {},
): Promise<{ pglite: PGlite; bridge: PGliteBridge; prisma: PrismaClient }> => {
  const pglite = options.pglite ?? (await createReadyPGlite());
  const bridge = new PGliteBridge({ ...options, pglite });
  await pushMigrations(pglite, { sql: MIGRATION_SQL });
  const prisma = new PrismaClient({ adapter: bridge.adapter });

  return { pglite, bridge, prisma };
};

const { pglite, prisma, bridge } = await setupSuite({ statsLevel: 'basic' });

describe('PGliteBridge', () => {
  beforeEach(async () => {
    await bridge.resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await bridge.close();
    await pglite.close();
  });

  it('rejects invalid stats levels', () => {
    expect(
      () =>
        new PGliteBridge({
          pglite,
          statsLevel: 'invalid' as 'basic',
        }),
    ).toThrow(`statsLevel must be 'off', 'basic', or 'full'; got invalid`);
  });

  it('returns telemetry when stats are enabled', async () => {
    await prisma.tenant.count();
    const stats = await bridge.stats();

    expect(stats).toBeDefined();
    expect(stats?.statsLevel).toBe('basic');
    expect(stats?.queryCount).toBeGreaterThan(0);
  });

  it(`returns undefined stats when statsLevel is 'off'`, async () => {
    const local = await createReadyPGlite();
    const localBridge = new PGliteBridge({ pglite: local });
    try {
      await expect(localBridge.stats()).resolves.toBeUndefined();
    } finally {
      await localBridge.close();
      await local.close();
    }
  });

  it('exposes the underlying pglite instance', () => {
    expect(bridge.pglite).toBe(pglite);
  });

  it('resetDb clears user data', async () => {
    await prisma.tenant.create({
      data: { id: 'tenant-reset', name: 'Reset Tenant', slug: 'tenant-reset' },
    });

    await bridge.resetDb();

    await expect(prisma.tenant.count()).resolves.toBe(0);
  });

  it('reuses an initialized persistent dataDir without re-applying migrations', async () => {
    const { parent, path: dataDir } = createTempDir('bridge-class-data');

    const firstPGlite = await createReadyPGlite(dataDir);
    const first = new PGliteBridge({ pglite: firstPGlite, statsLevel: 'basic' });
    await pushMigrations(firstPGlite, {
      sql: 'CREATE TABLE IF NOT EXISTS "Tenant" ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT NOT NULL)',
    });
    const firstPrisma = new PrismaClient({ adapter: first.adapter });

    await firstPrisma.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "name", "slug") VALUES ('tenant-persist', 'Persistent Tenant', 'tenant-persist')`,
    );

    await firstPrisma.$disconnect();
    await first.close();
    await firstPGlite.close();

    const secondPGlite = await createReadyPGlite(dataDir);
    const second = new PGliteBridge({ pglite: secondPGlite, statsLevel: 'basic' });
    const secondPrisma = new PrismaClient({ adapter: second.adapter });

    try {
      const { rows } = await secondPGlite.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM "Tenant"',
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      await secondPrisma.$disconnect();
      await second.close();
      await secondPGlite.close();
    }

    removeTempDir(parent);
  });

  it('snapshotDb restores the snapped state on resetDb', async () => {
    await prisma.tenant.create({
      data: { id: 'tenant-snap', name: 'Snapshot Tenant', slug: 'tenant-snap' },
    });

    await bridge.snapshotDb();

    await prisma.tenant.create({
      data: { id: 'tenant-extra', name: 'Extra Tenant', slug: 'tenant-extra' },
    });

    await bridge.resetDb();

    await expect(prisma.tenant.findMany({ orderBy: { id: 'asc' } })).resolves.toMatchObject([
      { id: 'tenant-snap', name: 'Snapshot Tenant', slug: 'tenant-snap' },
    ]);
  });

  it('resetSnapshot discards the current snapshot', async () => {
    await prisma.tenant.create({
      data: { id: 'tenant-drop', name: 'Drop Snapshot', slug: 'tenant-drop' },
    });

    await bridge.snapshotDb();
    await bridge.resetSnapshot();

    await prisma.tenant.create({
      data: { id: 'tenant-after-drop', name: 'After Drop', slug: 'tenant-after-drop' },
    });

    await bridge.resetDb();

    await expect(prisma.tenant.count()).resolves.toBe(0);
  });

  it('emitBridgeLeakWarning emits a typed process warning', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    emitBridgeLeakWarning();
    expect(spy).toHaveBeenCalledTimes(1);
    const [message, options] = spy.mock.calls[0] ?? [];
    expect(String(message)).toContain('garbage-collected');
    expect(String(message)).toContain('close()');
    expect(options).toEqual({ type: 'PGliteBridgeLeakWarning' });
  });

  it('registers the adapter for leak detection and unregisters on close', async () => {
    const registerSpy = vi.spyOn(FinalizationRegistry.prototype, 'register');
    const unregisterSpy = vi.spyOn(FinalizationRegistry.prototype, 'unregister');

    const local = await createReadyPGlite();
    const created = new PGliteBridge({ pglite: local });

    expect(registerSpy).toHaveBeenCalled();
    const registeredToken = registerSpy.mock.calls.at(-1)?.[2];
    expect(registeredToken).toBeDefined();

    await created.close();
    await local.close();

    expect(unregisterSpy).toHaveBeenCalledWith(registeredToken);
  });
});

describe('PGliteBridge — mocked pg.Pool', () => {
  type ClassModule = typeof import('./index.ts');

  const loadClassWithMocks = async ({
    poolEnd = vi.fn().mockResolvedValue(undefined),
    prismaPg = vi.fn().mockImplementation(function MockPrismaPg() {
      return { mocked: true };
    }),
  }: {
    poolEnd?: ReturnType<typeof vi.fn>;
    prismaPg?: ReturnType<typeof vi.fn>;
  } = {}): Promise<{
    PoolCtor: ReturnType<typeof vi.fn>;
    module: ClassModule;
    poolEnd: ReturnType<typeof vi.fn>;
    prismaPg: ReturnType<typeof vi.fn>;
  }> => {
    vi.resetModules();
    const PoolCtor = vi.fn().mockImplementation(function MockPool() {
      return { end: poolEnd };
    });
    const actualPg = (await vi.importActual<typeof import('pg')>('pg')).default;
    vi.doMock('pg', () => ({
      default: { ...actualPg, Pool: PoolCtor },
    }));
    vi.doMock('@prisma/adapter-pg', () => ({
      PrismaPg: prismaPg,
    }));
    return {
      PoolCtor,
      module: await import('./index.ts'),
      poolEnd,
      prismaPg,
    };
  };

  afterEach(() => {
    vi.doUnmock('pg');
    vi.doUnmock('@prisma/adapter-pg');
    vi.resetModules();
  });

  it('close is idempotent while shutdown is already in progress', async () => {
    let releaseEnd: (() => void) | undefined;
    const poolEnd = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseEnd = resolve;
        }),
    );
    const mockPglite = createMockPGlite();
    const { module } = await loadClassWithMocks({ poolEnd });
    const created = new module.PGliteBridge({ pglite: mockPglite });

    const closingA = created.close();
    const closingB = created.close();
    releaseEnd?.();

    await Promise.all([closingA, closingB]);

    expect(poolEnd).toHaveBeenCalledTimes(1);
  });

  it('installs a SessionLock when max > 1', async () => {
    const mockPglite = createMockPGlite();
    const { PoolCtor, module } = await loadClassWithMocks();

    const created = new module.PGliteBridge({ pglite: mockPglite, max: 2 });

    const poolConfig = PoolCtor.mock.calls[0]?.[0] as Record<symbol, { sessionLock: unknown }>;
    const optionsKey = Object.getOwnPropertySymbols(poolConfig).find(
      (sym) => sym.description === 'PgBridgeClientOptions',
    );
    expect(poolConfig[optionsKey!]?.sessionLock).toBeDefined();

    await created.close();
  });

  it('forwards syncToFs to the pool client options', async () => {
    const mockPglite = createMockPGlite();
    const { PoolCtor, module, prismaPg } = await loadClassWithMocks();

    const created = new module.PGliteBridge({ pglite: mockPglite, syncToFs: false });

    expect(PoolCtor).toHaveBeenCalledTimes(1);
    const poolConfig = PoolCtor.mock.calls[0]?.[0] as Record<symbol, { syncToFs: boolean }>;
    const optionsKey = Object.getOwnPropertySymbols(poolConfig).find(
      (sym) => sym.description === 'PgBridgeClientOptions',
    );
    expect(optionsKey).toBeDefined();
    expect(poolConfig[optionsKey!]?.syncToFs).toBe(false);
    expect(prismaPg).toHaveBeenCalled();
    expect(created.adapter).toEqual({ mocked: true });

    await created.close();
  });
});
