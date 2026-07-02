// Integration coverage for prepared-statement caching, running against a real
// PGlite and the real generated PrismaClient.
//
// With the opt-in `preparedStatements: true`, the bridge caches Prisma
// queries as named prepared statements (`ppb_<n>`). resetDb keeps those
// statements alive — tables are truncated, never dropped, so cached statements
// replan transparently — while still clearing the rest of the session state.
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

  it('caches nothing by default', async () => {
    const { bridge, prisma } = await setupSuite();
    try {
      await prisma.tenant.findMany();
      await prisma.tenant.findMany();

      expect(hasBridgeStatement(await listPreparedStatementNames(bridge))).toBe(false);
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
