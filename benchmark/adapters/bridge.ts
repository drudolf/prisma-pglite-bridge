import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { createPool } from '../../src/create-pool.ts';
import { stackProbe } from '../attribution.ts';
import type { AdapterHarness } from './types.ts';

export const bridge: AdapterHarness = {
  name: 'prisma-pglite-bridge',

  setup: async (schemaSql) => {
    stackProbe.patchPg();
    const { pool, pglite, close } = await createPool();
    stackProbe.instrumentBridgePglite(pglite);
    await pglite.exec(schemaSql);
    const adapterFactory = new PrismaPg(pool);
    const driverAdapter = await adapterFactory.connect();
    stackProbe.instrumentDriverAdapter(driverAdapter);
    const prisma = new PrismaClient({ adapter: adapterFactory });
    // Stash internals on the context for teardown/truncate
    Object.assign(prisma, {
      __pglite: pglite,
      __pool: pool,
      __close: close,
      __driverAdapter: driverAdapter,
      __stackProbe: stackProbe,
      __stackAdapterName: 'prisma-pglite-bridge',
    });
    return { prisma };
  },

  teardown: async (ctx) => {
    await ctx.prisma.$disconnect();
    const driverAdapter = (ctx.prisma as Record<string, unknown>).__driverAdapter as
      | { dispose: () => Promise<void> }
      | undefined;
    await driverAdapter?.dispose();
    const close = (ctx.prisma as Record<string, unknown>).__close as () => Promise<void>;
    await close();
  },

  truncate: async (ctx) => {
    const pglite = (ctx.prisma as Record<string, unknown>).__pglite as {
      query: <T>(sql: string) => Promise<{ rows: T[] }>;
      exec: (sql: string) => Promise<void>;
    };
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
