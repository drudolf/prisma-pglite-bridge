/** biome-ignore-all lint/style/noNonNullAssertion: test files only */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, removeTempDir } from '../__tests__/file-system.ts';
import { createMockPGlite } from '../__tests__/mocks.ts';
import { pushMigrations } from '../schema/migrations.ts';
import type { PGliteBridgeOptions } from './index.ts';
import { emitBridgeLeakWarning, PGliteBridge } from './index.ts';

const MIGRATION_SQL = readFileSync(
  join(process.cwd(), 'prisma/migrations/0001_init/migration.sql'),
  'utf8',
);

const setupSuite = async (
  options: PGliteBridgeOptions = {},
): Promise<{ bridge: PGliteBridge; prisma: PrismaClient }> => {
  const bridge = new PGliteBridge(options);
  await pushMigrations(bridge.pglite, { sql: MIGRATION_SQL });
  const prisma = new PrismaClient({ adapter: bridge.adapter });
  return { bridge, prisma };
};

const { prisma, bridge } = await setupSuite({ statsLevel: 'basic' });

describe('PGliteBridge', () => {
  beforeEach(async () => {
    await bridge.resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await bridge.close();
  });

  it('rejects invalid stats levels', () => {
    expect(
      () =>
        new PGliteBridge({
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
    // Reuse the shared pglite (caller-supplied) to avoid a redundant WASM boot.
    const localBridge = new PGliteBridge({ pglite: bridge.pglite });
    try {
      await expect(localBridge.stats()).resolves.toBeUndefined();
    } finally {
      await localBridge.close();
    }
  });

  it('exposes the underlying pglite instance', () => {
    expect(bridge.pglite).toBeInstanceOf(PGlite);
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

    const firstPGlite = new PGlite(dataDir);
    await firstPGlite.waitReady;
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

    const secondPGlite = new PGlite(dataDir);
    await secondPGlite.waitReady;
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

  it('close() closes the internally-created PGlite (bridge owns it)', async () => {
    const localBridge = new PGliteBridge();
    await localBridge.close();
    expect(localBridge.pglite.closed).toBe(true);
  });

  it('close() leaves a caller-supplied PGlite open (caller owns it)', async () => {
    // Reuse the shared pglite — close() on a non-owning bridge must not close it.
    const localBridge = new PGliteBridge({ pglite: bridge.pglite });
    await localBridge.close();
    expect(bridge.pglite.closed).toBe(false);
  });

  it('snapshotDb / resetDb / resetSnapshot reject when pool clients are in flight', async () => {
    let resolveStarted!: () => void;
    let resolveGate!: () => void;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });

    // Hold a pool client via an interactive transaction.
    const txP = prisma
      .$transaction(
        async () => {
          resolveStarted();
          await gate;
        },
        { timeout: 30_000 },
      )
      .catch(() => undefined);

    await started;

    await expect(bridge.snapshotDb()).rejects.toThrow(/in-flight pool queries/);
    await expect(bridge.resetSnapshot()).rejects.toThrow(/in-flight pool queries/);
    await expect(bridge.resetDb()).rejects.toThrow(/in-flight pool queries/);

    resolveGate();
    await txP;

    await expect(bridge.snapshotDb()).resolves.toBeUndefined();
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

    // Reuse the shared pglite (caller-supplied) to avoid a redundant WASM boot.
    const created = new PGliteBridge({ pglite: bridge.pglite });

    expect(registerSpy).toHaveBeenCalled();
    const registeredToken = registerSpy.mock.calls.at(-1)?.[2];
    expect(registeredToken).toBeDefined();

    await created.close();

    expect(unregisterSpy).toHaveBeenCalledWith(registeredToken);
  });
});

describe('PGliteBridge — adapter construction failure', () => {
  it('releases the shared-instance pool slot when PrismaPg construction throws', async () => {
    // Real `pg`, real PgBridgePool — only the adapter is mocked, throwing on
    // first construction. The bridge constructor creates its pool (which
    // counts toward the shared-instance tracker) before PrismaPg; if
    // PrismaPg throws, the slot must be released, or the next bridge on the
    // same PGlite gets a spurious PGliteBridgeSharedInstanceWarning.
    vi.resetModules();
    const prismaPg = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('adapter boom');
      })
      .mockImplementation(function MockPrismaPg() {
        return { mocked: true };
      });
    vi.doMock('@prisma/adapter-pg', () => ({ PrismaPg: prismaPg }));

    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      if (warning.name === 'PGliteBridgeSharedInstanceWarning') warnings.push(warning);
    };
    process.on('warning', onWarning);
    try {
      const module = await import('./index.ts');
      const mockPglite = createMockPGlite();

      expect(() => new module.PGliteBridge({ pglite: mockPglite })).toThrow('adapter boom');

      // Caller-supplied instance: the failure path releases the pool slot
      // but must never close a PGlite the bridge does not own. Flush the
      // best-effort async cleanup chain before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      expect(vi.mocked(mockPglite.close)).not.toHaveBeenCalled();

      const bridge = new module.PGliteBridge({ pglite: mockPglite });
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings).toHaveLength(0);
      await bridge.close();
    } finally {
      process.removeListener('warning', onWarning);
      vi.doUnmock('@prisma/adapter-pg');
      vi.resetModules();
    }
  });

  it('closes the bridge-owned PGlite when PrismaPg construction throws', async () => {
    // Owned path: no `pglite` option, so the bridge constructs its own
    // instance through the mocked module. After the constructor throws, the
    // half-built bridge is unreachable — nothing else can ever close that
    // instance, so the failure path itself must.
    vi.resetModules();
    const ownedInstance = createMockPGlite();
    const pgliteCtor = vi.fn().mockImplementation(function MockPGlite() {
      return ownedInstance;
    });
    vi.doMock('@electric-sql/pglite', () => ({ PGlite: pgliteCtor }));
    vi.doMock('@prisma/adapter-pg', () => ({
      PrismaPg: vi.fn().mockImplementation(function MockPrismaPg() {
        throw new Error('adapter boom');
      }),
    }));
    try {
      const module = await import('./index.ts');

      expect(() => new module.PGliteBridge()).toThrow('adapter boom');

      // The cleanup (pool.end() → pglite.close()) is an async best-effort
      // chain — flush it before asserting.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(pgliteCtor).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ownedInstance.close)).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock('@electric-sql/pglite');
      vi.doUnmock('@prisma/adapter-pg');
      vi.resetModules();
    }
  });

  it('swallows a rejecting close() of the owned PGlite on the failure path', async () => {
    vi.resetModules();
    const ownedInstance = createMockPGlite({
      close: vi.fn().mockRejectedValue(new Error('close boom')),
    });
    vi.doMock('@electric-sql/pglite', () => ({
      PGlite: vi.fn().mockImplementation(function MockPGlite() {
        return ownedInstance;
      }),
    }));
    vi.doMock('@prisma/adapter-pg', () => ({
      PrismaPg: vi.fn().mockImplementation(function MockPrismaPg() {
        throw new Error('adapter boom');
      }),
    }));
    // A passive "no unhandled rejection" is runner-sensitive (condition):
    // trap explicitly, flush, assert the trap never fired, remove in finally.
    const unhandled: unknown[] = [];
    const trap = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', trap);
    try {
      const module = await import('./index.ts');

      expect(() => new module.PGliteBridge()).toThrow('adapter boom');

      // Two turns: the first lets the pool-end chain reach close(), the
      // second lets an unswallowed close rejection surface to the trap.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(vi.mocked(ownedInstance.close)).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', trap);
      vi.doUnmock('@electric-sql/pglite');
      vi.doUnmock('@prisma/adapter-pg');
      vi.resetModules();
    }
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
      // PgBridgePool registers a 'connect' listener in its constructor.
      return { end: poolEnd, on: vi.fn() };
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

  type PrismaPgTestOptions =
    | {
        schema?: string;
        statementNameGenerator?: (query: { sql: string }) => string | undefined;
      }
    | undefined;

  const prismaPgOptions = (prismaPg: ReturnType<typeof vi.fn>): PrismaPgTestOptions =>
    prismaPg.mock.calls[0]?.[1] as PrismaPgTestOptions;

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

  it.each([
    {},
    { preparedStatements: true },
    { preparedStatements: false },
    { max: 2 },
    { max: 2, preparedStatements: true },
  ])('never passes a statementNameGenerator to PrismaPg (options: %o)', async (extra) => {
    // Statement names are injected per client inside PgBridgeClient.query()
    // — that covers the adapter path with full client context. A pool-level
    // generator handed to PrismaPg would wrongly share one namespace across
    // clients (ADR 002 / per-client statement-name scoping).
    const mockPglite = createMockPGlite();
    const { module, prismaPg } = await loadClassWithMocks();

    const created = new module.PGliteBridge({ pglite: mockPglite, ...extra });

    expect(prismaPg).toHaveBeenCalledTimes(1);
    expect(prismaPgOptions(prismaPg)?.statementNameGenerator).toBeUndefined();

    await created.close();
  });

  it('constructs with preparedStatements: true and max > 1 — per-client names make caching safe at any max', async () => {
    const mockPglite = createMockPGlite();
    const { module, prismaPg } = await loadClassWithMocks();

    const created = new module.PGliteBridge({
      pglite: mockPglite,
      max: 2,
      preparedStatements: true,
    });

    expect(prismaPg).toHaveBeenCalledTimes(1);
    expect(created.adapter).toEqual({ mocked: true });

    await created.close();
  });

  it('forwards schema to PrismaPg when set', async () => {
    const mockPglite = createMockPGlite();
    const { module, prismaPg } = await loadClassWithMocks();

    const created = new module.PGliteBridge({
      pglite: mockPglite,
      schema: 'tenant_a',
      preparedStatements: false,
    });

    expect(prismaPgOptions(prismaPg)?.schema).toBe('tenant_a');

    await created.close();
  });

  it('passes no schema by default', async () => {
    const mockPglite = createMockPGlite();
    const { module, prismaPg } = await loadClassWithMocks();

    const created = new module.PGliteBridge({ pglite: mockPglite });

    expect(prismaPgOptions(prismaPg)?.schema).toBeUndefined();

    await created.close();
  });

  it('forwards schema alongside preparedStatements: true — still no generator', async () => {
    const mockPglite = createMockPGlite();
    const { module, prismaPg } = await loadClassWithMocks();

    const created = new module.PGliteBridge({
      pglite: mockPglite,
      schema: 'tenant_b',
      preparedStatements: true,
    });

    const options = prismaPgOptions(prismaPg);
    expect(options?.schema).toBe('tenant_b');
    expect(options?.statementNameGenerator).toBeUndefined();

    await created.close();
  });
});
