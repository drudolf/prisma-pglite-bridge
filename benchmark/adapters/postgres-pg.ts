import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { stackProbe } from '../attribution.ts';
import { getBenchEnv } from '../env.ts';
import type { AdapterHarness, ExternalProcessSampler } from './types.ts';

const resolveConnectionString = (): string => {
  const connectionString = getBenchEnv('BENCH_POSTGRES_URL') ?? getBenchEnv('DATABASE_URL');
  if (!connectionString) {
    throw new Error(
      'postgres-pg benchmark adapter requires BENCH_POSTGRES_URL or DATABASE_URL in .env.test or the process environment',
    );
  }
  return connectionString;
};

const parseServerPids = (): number[] => {
  const raw =
    getBenchEnv('BENCH_POSTGRES_SERVER_PIDS') ??
    getBenchEnv('POSTGRES_SERVER_PIDS') ??
    getBenchEnv('BENCH_POSTGRES_SERVER_PID') ??
    getBenchEnv('POSTGRES_SERVER_PID');
  if (!raw) return [];

  return raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
};

const createServerProcessSampler = (): ExternalProcessSampler | undefined => {
  const pids = parseServerPids();
  if (pids.length === 0) return undefined;

  return {
    label: 'postgres-server',
    listPids: () => pids,
  };
};

const resetSchema = async (pool: Pool, schemaSql: string) => {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;
    GRANT ALL ON SCHEMA public TO CURRENT_USER;
    GRANT ALL ON SCHEMA public TO public;
  `);
  await pool.query(schemaSql);
};

export const postgresPg: AdapterHarness = {
  name: 'postgres-pg',

  setup: async (schemaSql) => {
    stackProbe.patchPg();

    const pool = new Pool({
      connectionString: resolveConnectionString(),
      max: 1,
    });

    await resetSchema(pool, schemaSql);

    const adapterFactory = new PrismaPg(pool);
    const driverAdapter = await adapterFactory.connect();
    stackProbe.instrumentDriverAdapter(driverAdapter);
    const prisma = new PrismaClient({ adapter: adapterFactory });

    Object.assign(prisma, {
      __pool: pool,
      __driverAdapter: driverAdapter,
      __stackProbe: stackProbe,
      __stackAdapterName: 'postgres-pg',
    });

    return {
      prisma,
      serverProcessSampler: createServerProcessSampler(),
    };
  },

  teardown: async (ctx) => {
    await ctx.prisma.$disconnect();
    const driverAdapter = (ctx.prisma as unknown as Record<string, unknown>).__driverAdapter as
      | { dispose: () => Promise<void> }
      | undefined;
    await driverAdapter?.dispose();
    const pool = (ctx.prisma as unknown as Record<string, unknown>).__pool as Pool;
    await pool.end();
  },

  truncate: async (ctx) => {
    const pool = (ctx.prisma as unknown as Record<string, unknown>).__pool as Pool;
    const { rows } = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'`,
    );

    if (rows.length === 0) return;

    await pool.query('SET session_replication_role = replica');
    try {
      for (const row of rows) {
        await pool.query(`TRUNCATE TABLE "${row.tablename}" CASCADE`);
      }
    } finally {
      await pool.query('SET session_replication_role = DEFAULT');
    }
  },
};
