// Integration parity for the FastQuery fast path: the same operation
// sequence must produce identical results whether queries travel the fast
// path (the default — adapter-pg emits the fast shape when statement
// caching names the query, and preparedStatements defaults on at max 1)
// or the stock pg path (`fastQueryPath: false`).
//
// NOTE (red phase): until the fast path lands in PgBridgePool,
// `fastQueryPath: false` is ignored at runtime — BOTH bridges run the
// stock path and these parity tests pass trivially. They become
// discriminating once the fast path is implemented; the red-phase
// describe-skip spy tests live in src/pool/index.test.ts.
import { Prisma, PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { PGliteBridge, type PGliteBridgeOptions, pushMigrations } from '../../index.ts';

const setupSuite = async (
  options: PGliteBridgeOptions = {},
): Promise<{ bridge: PGliteBridge; prisma: PrismaClient }> => {
  const bridge = new PGliteBridge(options);
  await pushMigrations(bridge.pglite, { configRoot: process.cwd() });
  const prisma = new PrismaClient({ adapter: bridge.adapter });
  return { bridge, prisma };
};

// `fastQueryPath` is a PgBridgePool option, not a typed PGliteBridge
// option — it reaches the pool through PGliteBridge's `...options` spread.
const stockPathOptions = { fastQueryPath: false } as unknown as PGliteBridgeOptions;

type Suite = { bridge: PGliteBridge; prisma: PrismaClient };

const setupPair = async (): Promise<{
  fast: Suite;
  stock: Suite;
  closeAll: () => Promise<void>;
}> => {
  const fast = await setupSuite();
  const stock = await setupSuite(stockPathOptions);
  const closeAll = async (): Promise<void> => {
    await fast.prisma.$disconnect();
    await stock.prisma.$disconnect();
    await fast.bridge.close();
    await stock.bridge.close();
  };
  return { fast, stock, closeAll };
};

// Fixed timestamps keep create/update payloads byte-identical across the
// two bridges — the schema allows explicit createdAt everywhere it appears.
const T0 = new Date('2026-01-01T00:00:00.000Z');

const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

// The runtime operation corpus, mirroring the prepared-statements corpus:
// every DML shape Prisma emits, including String[] labels/tags, nested
// Json, Decimal, an include across a relation, and an interactive
// transaction. Returns results keyed by operation for the parity diff.
//
// Note: workspace.create runs BEFORE the include-findMany so the Decimal
// rateLimit and tags String[] actually flow through the included relation.
const runCorpus = async (prisma: PrismaClient): Promise<Record<string, unknown>> => {
  const results: Record<string, unknown> = {};

  results.create = await prisma.tenant.create({
    data: {
      id: 'tenant-fq-1',
      name: 'FQ One',
      slug: 'fq-1',
      labels: ['alpha', 'beta'],
      config: { plan: 'pro', nested: { tier: 1 } },
      createdAt: T0,
    },
  });
  results.createMany = await prisma.tenant.createMany({
    data: [
      { id: 'tenant-fq-2', name: 'FQ Two', slug: 'fq-2', createdAt: T0 },
      { id: 'tenant-fq-3', name: 'FQ Three', slug: 'fq-3', createdAt: T0 },
    ],
  });
  results.findMany = await prisma.tenant.findMany({ take: 10 });
  results.findUnique = await prisma.tenant.findUnique({ where: { id: 'tenant-fq-1' } });
  results.update = await prisma.tenant.update({
    where: { id: 'tenant-fq-1' },
    data: {
      config: { plan: 'enterprise', limits: { rpm: 100, tiers: ['gold', 'silver'] } },
      labels: ['x', 'y'],
    },
  });
  results.count = await prisma.tenant.count();
  // GROUP BY output order is not contractual — normalize symmetrically.
  const grouped = await prisma.tenant.groupBy({ by: ['slug'] });
  results.groupBy = [...grouped].sort((a, b) => a.slug.localeCompare(b.slug));
  results.workspaceCreate = await prisma.workspace.create({
    data: {
      id: 'ws-fq-1',
      name: 'FQ Workspace',
      slug: 'ws-1',
      tenantId: 'tenant-fq-1',
      rateLimit: '12.34',
      tags: ['t1', 't2'],
      settings: { region: 'eu' },
      apiKey: 'fq-api-key-1',
      createdAt: T0,
    },
  });
  results.findManyInclude = await prisma.tenant.findMany({
    include: { workspaces: true },
  });
  // tenant-fq-3 has no workspaces, so the delete cannot trip the FK.
  results.delete = await prisma.tenant.delete({ where: { id: 'tenant-fq-3' } });
  results.transaction = await prisma.$transaction(async (tx) => {
    const count = await tx.tenant.count();
    const rows = await tx.tenant.findMany();
    return { count, rows };
  });

  return results;
};

const runNullOps = async (prisma: PrismaClient): Promise<Record<string, unknown>> => {
  const results: Record<string, unknown> = {};

  await prisma.tenant.create({
    data: {
      id: 'tenant-null-1',
      name: 'Null One',
      slug: 'null-1',
      config: { plan: 'temp' },
      createdAt: T0,
    },
  });
  results.updateToDbNull = await prisma.tenant.update({
    where: { id: 'tenant-null-1' },
    data: { config: Prisma.DbNull },
  });
  results.readBack = await prisma.tenant.findUnique({ where: { id: 'tenant-null-1' } });
  results.configIsNull = await prisma.tenant.findMany({
    where: { config: { equals: Prisma.DbNull } },
  });

  // Plain NULL filter on a nullable scalar column.
  await prisma.catalogEntry.create({
    data: {
      id: 'entry-null-1',
      friendlyId: 'entry-null-1',
      name: 'Null Entry',
      pattern: 'p-*',
      provider: 'test',
      baseName: null,
      createdAt: T0,
    },
  });
  results.baseNameIsNull = await prisma.catalogEntry.findMany({ where: { baseName: null } });

  return results;
};

const captureUniqueViolation = async (prisma: PrismaClient): Promise<unknown> => {
  await prisma.tenant.create({
    data: { id: 'tenant-dup-a', name: 'Dup A', slug: 'dup', createdAt: T0 },
  });
  try {
    await prisma.tenant.create({
      data: { id: 'tenant-dup-b', name: 'Dup B', slug: 'dup', createdAt: T0 },
    });
  } catch (err) {
    return err;
  }
  return undefined;
};

const runRollback = async (prisma: PrismaClient): Promise<number> => {
  await expect(
    prisma.$transaction(async (tx) => {
      await tx.tenant.create({
        data: { id: 'tenant-tx-1', name: 'TX Tenant', slug: 'tx-1', createdAt: T0 },
      });
      await tx.tenant.findMany();
      throw new Error('rollback-now');
    }),
  ).rejects.toThrow('rollback-now');
  return prisma.tenant.count();
};

describe('fast-query path parity', () => {
  it('produces identical results for the operation corpus on both paths', async () => {
    const { fast, stock, closeAll } = await setupPair();
    try {
      const fastResults = await runCorpus(fast.prisma);
      const stockResults = await runCorpus(stock.prisma);

      expect(asJson(fastResults)).toEqual(asJson(stockResults));

      // Guard against a vacuous corpus: the include really carried a
      // workspace with its Decimal rateLimit and tags String[].
      const included = fastResults.findManyInclude as Array<{
        workspaces: Array<{ rateLimit: unknown; tags: string[] }>;
      }>;
      const workspaces = included.flatMap((tenant) => tenant.workspaces);
      expect(workspaces).toHaveLength(1);
      expect(String(workspaces[0]?.rateLimit)).toBe('12.34');
      expect(workspaces[0]?.tags).toEqual(['t1', 't2']);
    } finally {
      await closeAll();
    }
  });

  it('round-trips DbNull writes and null filters identically on both paths', async () => {
    const { fast, stock, closeAll } = await setupPair();
    try {
      const fastResults = await runNullOps(fast.prisma);
      const stockResults = await runNullOps(stock.prisma);

      expect(asJson(fastResults)).toEqual(asJson(stockResults));

      // The DbNull write really landed and both filters really matched.
      expect((fastResults.readBack as { config: unknown }).config).toBeNull();
      expect(fastResults.configIsNull as unknown[]).toHaveLength(1);
      expect(fastResults.baseNameIsNull as unknown[]).toHaveLength(1);
    } finally {
      await closeAll();
    }
  });

  it('surfaces the same P2002 unique-violation code on both paths', async () => {
    const { fast, stock, closeAll } = await setupPair();
    try {
      const fastErr = await captureUniqueViolation(fast.prisma);
      const stockErr = await captureUniqueViolation(stock.prisma);

      for (const err of [fastErr, stockErr]) {
        expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
      }
    } finally {
      await closeAll();
    }
  });

  it('rolls back a failed interactive transaction on both paths', async () => {
    const { fast, stock, closeAll } = await setupPair();
    try {
      expect(await runRollback(fast.prisma)).toBe(0);
      expect(await runRollback(stock.prisma)).toBe(0);

      // The created row must be absent on both bridges.
      expect(await fast.prisma.tenant.findUnique({ where: { id: 'tenant-tx-1' } })).toBeNull();
      expect(await stock.prisma.tenant.findUnique({ where: { id: 'tenant-tx-1' } })).toBeNull();
    } finally {
      await closeAll();
    }
  });

  it('resetDb restores snapshot state with a warm fast-path fields cache', async () => {
    const { bridge, prisma } = await setupSuite();
    try {
      await prisma.tenant.create({
        data: { id: 'tenant-seeded', name: 'Seeded Tenant', slug: 'seeded', createdAt: T0 },
      });
      await bridge.snapshotDb();

      // Warm the fast path's fields cache with the query under test.
      await expect(prisma.tenant.findMany()).resolves.toMatchObject([{ id: 'tenant-seeded' }]);

      await prisma.tenant.create({
        data: { id: 'tenant-extra', name: 'Extra Tenant', slug: 'extra', createdAt: T0 },
      });
      await bridge.resetDb();

      // The warm-cache query sees the restored snapshot state, no error.
      await expect(prisma.tenant.findMany()).resolves.toMatchObject([{ id: 'tenant-seeded' }]);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });
});
