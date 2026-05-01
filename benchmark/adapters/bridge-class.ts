/**
 * Adapter harness for the prototype `PGliteBridge` class — the
 * synchronous-constructor variant of {@link createPGliteBridge}.
 *
 * Mirrors `bridge.ts` so the two adapters can be benchmarked head-to-head.
 * The class exposes `adapter` (PrismaPg) directly; we still call
 * `adapter.connect()` for `instrumentDriverAdapter` parity with the factory
 * harness.
 */
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { PGliteBridge } from '../../src/pglite-bridge-class.ts';
import { stackProbe } from '../attribution.ts';
import type { AdapterHarness } from './types.ts';

export const bridgeClass: AdapterHarness = {
  name: 'prisma-pglite-bridge-class',

  setup: async (schemaSql) => {
    stackProbe.patchPg();
    const pglite = new PGlite();
    await pglite.waitReady;
    const bridge = new PGliteBridge({ pglite });
    stackProbe.instrumentBridgePGlite(pglite);
    await pglite.exec(schemaSql);
    const driverAdapter = await bridge.adapter.connect();
    stackProbe.instrumentDriverAdapter(driverAdapter);
    const prisma = new PrismaClient({ adapter: bridge.adapter });
    Object.assign(prisma, {
      __pglite: pglite,
      __bridge: bridge,
      __close: bridge.close,
      __driverAdapter: driverAdapter,
      __stackProbe: stackProbe,
      __stackAdapterName: 'prisma-pglite-bridge-class',
    });
    return { prisma };
  },

  teardown: async (ctx) => {
    await ctx.prisma.$disconnect();
    const driverAdapter = (ctx.prisma as unknown as Record<string, unknown>).__driverAdapter as
      | { dispose: () => Promise<void> }
      | undefined;
    await driverAdapter?.dispose();
    const close = (ctx.prisma as unknown as Record<string, unknown>).__close as () => Promise<void>;
    await close();
    const pglite = (ctx.prisma as unknown as Record<string, unknown>).__pglite as PGlite;
    await pglite.close();
  },

  truncate: async (ctx) => {
    const pglite = (ctx.prisma as unknown as Record<string, unknown>).__pglite as {
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
