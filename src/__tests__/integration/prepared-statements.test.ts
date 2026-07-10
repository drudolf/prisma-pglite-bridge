// Integration coverage for prepared-statement caching, running against a real
// PGlite and the real generated PrismaClient.
//
// Caching is ON by default for every pool size: each pool client caches
// Prisma queries as named prepared statements (`ppb_<namespace>_<n>`, one
// process-unique namespace per client, so names never collide across clients
// or pools sharing the PGlite session). Opt out with
// `preparedStatements: false`. resetDb keeps cached statements alive —
// tables are truncated, never dropped, so cached statements replan
// transparently — while still clearing the rest of the session state.
import { PrismaClient } from '@prisma/client';
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

const listPreparedStatementNames = async (bridge: PGliteBridge): Promise<string[]> => {
  const { rows } = await bridge.pglite.query<{ name: string }>(
    'SELECT name FROM pg_prepared_statements',
  );
  return rows.map((row) => row.name);
};

const hasBridgeStatement = (names: string[]): boolean =>
  names.some((name) => name.startsWith('ppb_'));

describe('prepared-statement caching', () => {
  it('caches Prisma queries as ppb_-named statements when opted in', async () => {
    const { bridge, prisma } = await setupSuite({ preparedStatements: true });
    try {
      await prisma.tenant.findMany();
      await prisma.tenant.findMany();

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(true);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('caches by default at max 1', async () => {
    const { bridge, prisma } = await setupSuite();
    try {
      await prisma.tenant.findMany();
      await prisma.tenant.findMany();

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(true);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('caches by default with a caller-supplied PGlite', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pglite = new PGlite();
    try {
      const bridge = new PGliteBridge({ pglite });
      await pushMigrations(pglite, { configRoot: process.cwd() });
      const prisma = new PrismaClient({ adapter: bridge.adapter });

      await prisma.tenant.findMany();
      await prisma.tenant.findMany();

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(true);

      await prisma.$disconnect();
      await bridge.close();
    } finally {
      await pglite.close();
    }
  });

  it('caches by default at max > 1 — per-client names make wider pools safe', async () => {
    const { bridge, prisma } = await setupSuite({ max: 2 });
    try {
      await prisma.tenant.findMany();
      await prisma.tenant.findMany();

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(true);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('caches nothing when preparedStatements is explicitly false', async () => {
    const { bridge, prisma } = await setupSuite({ preparedStatements: false });
    try {
      await prisma.tenant.findMany();
      await prisma.tenant.findMany();

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(false);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('constructs and caches with preparedStatements: true and max: 2', async () => {
    // Per-client statement names removed the max: 1 restriction — each
    // client caches under its own namespace, so wider pools cache safely
    // and the former constructor TypeError is gone.
    const { bridge, prisma } = await setupSuite({ preparedStatements: true, max: 2 });
    try {
      await prisma.tenant.findMany();
      await prisma.tenant.findMany();

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(true);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('caches every runtime Prisma SQL shape and never transaction control', async () => {
    const { bridge, prisma } = await setupSuite();
    try {
      await prisma.tenant.create({
        data: { id: 'tenant-corpus-1', name: 'Corpus One', slug: 'corpus-1' },
      });
      await prisma.tenant.createMany({
        data: [
          { id: 'tenant-corpus-2', name: 'Corpus Two', slug: 'corpus-2' },
          { id: 'tenant-corpus-3', name: 'Corpus Three', slug: 'corpus-3' },
        ],
      });
      await prisma.tenant.findMany({ take: 10 });
      await prisma.tenant.findUnique({ where: { id: 'tenant-corpus-1' } });
      await prisma.tenant.update({
        where: { id: 'tenant-corpus-1' },
        data: { name: 'Corpus One Updated' },
      });
      await prisma.tenant.count();
      await prisma.tenant.groupBy({ by: ['slug'] });
      await prisma.tenant.findMany({ include: { workspaces: true } });
      await prisma.tenant.delete({ where: { id: 'tenant-corpus-3' } });
      await prisma.$transaction(async (tx) => {
        await tx.tenant.count();
        await tx.tenant.findMany();
      });

      const { rows } = await bridge.pglite.query<{ name: string; statement: string }>(
        'SELECT name, statement FROM pg_prepared_statements',
      );
      const statements = rows.map((row) => row.statement);

      // Every DML shape Prisma emits at runtime ends up cached…
      expect(statements.some((statement) => /^select/i.test(statement))).toBe(true);
      expect(statements.some((statement) => /^insert/i.test(statement))).toBe(true);
      expect(statements.some((statement) => /^update/i.test(statement))).toBe(true);
      expect(statements.some((statement) => /^delete/i.test(statement))).toBe(true);
      // …while transaction control and session statements never are.
      expect(
        statements.filter((statement) =>
          /^(begin|commit|rollback|set|deallocate)/i.test(statement),
        ),
      ).toEqual([]);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('keeps cached statements working across resetDb', async () => {
    const { bridge, prisma } = await setupSuite({ preparedStatements: true });
    try {
      await prisma.tenant.create({
        data: { id: 'tenant-seeded', name: 'Seeded Tenant', slug: 'seeded' },
      });
      await bridge.snapshotDb();

      // Populate the statement cache with the query under test.
      await expect(prisma.tenant.findMany()).resolves.toMatchObject([{ id: 'tenant-seeded' }]);

      await prisma.tenant.create({
        data: { id: 'tenant-extra', name: 'Extra Tenant', slug: 'extra' },
      });
      await bridge.resetDb();

      // The same query reuses the cached statement: no error, and it sees the
      // restored snapshot state, not the pre-reset data.
      await expect(prisma.tenant.findMany()).resolves.toMatchObject([{ id: 'tenant-seeded' }]);

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(true);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('still resets session variables on resetDb', async () => {
    const { bridge, prisma } = await setupSuite();
    try {
      await prisma.$executeRawUnsafe(`SET application_name = 'probe'`);
      await bridge.resetDb();

      const { rows } = await bridge.pglite.query<{ value: string }>(
        `SELECT current_setting('application_name') AS value`,
      );
      expect(rows[0]?.value).not.toBe('probe');
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('a fresh client on the same PGlite starts with a clean statement namespace', async () => {
    // Statements live in PGlite's single shared session and outlive pg
    // clients. Without connect-time cleanup, a replacement client
    // re-preparing a known name fails with 42P05 "already exists".
    const { PGlite } = await import('@electric-sql/pglite');
    const pglite = new PGlite();
    try {
      const first = new PGliteBridge({ pglite, preparedStatements: true });
      await pushMigrations(pglite, { configRoot: process.cwd() });
      const prismaA = new PrismaClient({ adapter: first.adapter });
      await prismaA.tenant.findMany();
      await prismaA.$disconnect();
      await first.close();

      const second = new PGliteBridge({ pglite, preparedStatements: true });
      const prismaB = new PrismaClient({ adapter: second.adapter });
      // Same query shape → same generated name → would collide without
      // the connect-time DEALLOCATE.
      await expect(prismaB.tenant.findMany()).resolves.toEqual([]);
      await prismaB.$disconnect();
      await second.close();
    } finally {
      await pglite.close();
    }
  });
});
