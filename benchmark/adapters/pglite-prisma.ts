import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PrismaPGlite } from 'pglite-prisma-adapter';
import { stackProbe } from '../attribution.ts';
import type { AdapterHarness } from './types.ts';

export const pglitePrisma: AdapterHarness = {
  name: 'pglite-prisma-adapter',

  setup: async (schemaSql) => {
    const pglite = new PGlite();
    await pglite.waitReady;
    stackProbe.instrumentDirectPglite(pglite);
    await pglite.exec(schemaSql);
    const adapterFactory = new PrismaPGlite(pglite);
    const driverAdapter = await adapterFactory.connect();
    stackProbe.instrumentDriverAdapter(driverAdapter);
    const prisma = new PrismaClient({ adapter: adapterFactory });
    Object.assign(prisma, {
      __pglite: pglite,
      __driverAdapter: driverAdapter,
      __stackProbe: stackProbe,
      __stackAdapterName: 'pglite-prisma-adapter',
    });
    return { prisma };
  },

  teardown: async (ctx) => {
    await ctx.prisma.$disconnect();
    const driverAdapter = (ctx.prisma as Record<string, unknown>).__driverAdapter as
      | { dispose: () => Promise<void> }
      | undefined;
    await driverAdapter?.dispose();
    const pglite = (ctx.prisma as Record<string, unknown>).__pglite as PGlite;
    await pglite.close();
  },

  truncate: async (ctx) => {
    const pglite = (ctx.prisma as Record<string, unknown>).__pglite as PGlite;
    const { rows } = await pglite.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
    );
    if (rows.length > 0) {
      await pglite.exec('SET session_replication_role = replica');
      for (const row of rows) {
        await pglite.exec(`TRUNCATE TABLE "${row.tablename}" CASCADE`);
      }
      await pglite.exec('SET session_replication_role = DEFAULT');
    }
  },
};
