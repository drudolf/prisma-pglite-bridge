import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PGliteBridge } from '../pglite-bridge';
import { PgBridgePool } from '../pool';
import { pushSchema, resetSchema } from './index.ts';

const SCHEMA_BASE = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

enum Color {
  RED
  BLUE
}

model Widget {
  id    Int    @id @default(autoincrement())
  name  String @unique
  color Color  @default(RED)
}
`;

const SCHEMA_DROP_COLUMN = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

enum Color {
  RED
  BLUE
}

model Widget {
  id    Int    @id @default(autoincrement())
  color Color  @default(RED)
}
`;

const listTables = async (pglite: PGlite): Promise<string[]> => {
  const r = await pglite.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `);
  return r.rows.map((row) => row.table_name);
};

// Drop all non-system schemas and recreate public, resetting the shared PGlite
// instance to an empty slate. Runs after each test that applies DDL.
// ROLLBACK is swallowed (defensive no-op); schema drops and DISCARD ALL are
// loud — a failure means the previous test left dirty state.
const resetPublicSchema = async (pglite: PGlite): Promise<void> => {
  await pglite.query('ROLLBACK').catch(() => {});
  const { rows } = await pglite.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'`,
  );
  for (const { nspname } of rows) {
    await pglite.exec(`DROP SCHEMA IF EXISTS "${nspname.replace(/"/g, '""')}" CASCADE`);
  }
  await pglite.exec('CREATE SCHEMA IF NOT EXISTS "public"');
  await pglite.exec('DISCARD ALL');
};

// ---------------------------------------------------------------------------
// Shared PGlite instances — one per describe block, booted once at module
// top level to avoid ~1.3 s WASM cold-boot overhead per test.
// ---------------------------------------------------------------------------
const pgPushSchema = new PGlite();
await pgPushSchema.waitReady;

const pgResetSchema = new PGlite();
await pgResetSchema.waitReady;

const pgInjected = new PGlite();
await pgInjected.waitReady;

describe('pushSchema', () => {
  // Each test rebuilds the bridge so session/pool state does not leak.
  // afterEach drops all user schemas (loud) to give the next test a
  // pristine slate; the shared PGlite is closed once in afterAll.
  let bridge = new PGliteBridge({ pglite: pgPushSchema });

  afterEach(async () => {
    await bridge.close();
    // Barrier: serialize behind any in-flight teardown queries.
    await pgPushSchema.query('SELECT 1').catch(() => {});
    await resetPublicSchema(pgPushSchema);
    bridge = new PGliteBridge({ pglite: pgPushSchema });
  });

  afterAll(async () => {
    await bridge.close();
    await pgPushSchema.close();
  });

  it('applies a schema and creates tables (PGliteBridge target)', async () => {
    const result = await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });

    expect(result.executedSteps).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(result.unexecutable).toEqual([]);
    expect(await listTables(pgPushSchema)).toContain('Widget');
  });

  it('accepts a raw PrismaPg target', async () => {
    const pool = new PgBridgePool({ pglite: pgPushSchema });
    const prismaPg = new PrismaPg(pool);
    try {
      const result = await pushSchema(prismaPg, { schema: SCHEMA_BASE, forceReset: true });

      expect(result.executedSteps).toBeGreaterThan(0);
      expect(await listTables(pgPushSchema)).toContain('Widget');
    } finally {
      await pool.end();
    }
  });

  it('forceReset drops pre-existing tables before applying', async () => {
    await pgPushSchema.exec(`CREATE TABLE legacy ("id" INT PRIMARY KEY)`);
    expect(await listTables(pgPushSchema)).toContain('legacy');

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    const tables = await listTables(pgPushSchema);
    expect(tables).toContain('Widget');
    expect(tables).not.toContain('legacy');
  });

  it('forceReset clears snapshot manager state', async () => {
    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
    await pgPushSchema.exec(`INSERT INTO "Widget" ("name") VALUES ('seed')`);
    await bridge.snapshotDb();

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    await expect(bridge.resetDb()).resolves.toBeUndefined();
  });

  it('forceReset handles schema names containing semicolons', async () => {
    await pgPushSchema.exec(`CREATE SCHEMA "semi;name"`);
    await pgPushSchema.exec(`CREATE TABLE "semi;name"."t" ("id" INT PRIMARY KEY)`);

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    const left = await pgPushSchema.query<{ schemaname: string }>(`
      SELECT schemaname FROM pg_tables WHERE schemaname = 'semi;name'
    `);
    expect(left.rows).toEqual([]);
  });

  it('forceReset drops tables in non-public user schemas', async () => {
    await pgPushSchema.exec(`
      CREATE SCHEMA base;
      CREATE TABLE base."A" ("id" INT PRIMARY KEY);
    `);

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    const left = await pgPushSchema.query<{ schemaname: string; tablename: string }>(`
      SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    `);
    const inBase = left.rows.filter((r) => r.schemaname === 'base');
    expect(inBase).toEqual([]);
  });

  it('returns warnings without throwing for destructive change when acceptDataLoss is false', async () => {
    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
    await pgPushSchema.exec(`INSERT INTO "Widget" ("name") VALUES ('a'), ('b')`);

    const result = await pushSchema(bridge.adapter, { schema: SCHEMA_DROP_COLUMN });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.unexecutable).toEqual([]);
    expect(result.executedSteps).toBe(0);

    const cols = await pgPushSchema.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='Widget'
    `);
    expect(cols.rows.map((r) => r.column_name)).toContain('name');
  });

  it('applies destructive change with acceptDataLoss=true', async () => {
    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
    await pgPushSchema.exec(`INSERT INTO "Widget" ("name") VALUES ('a'), ('b')`);

    const result = await pushSchema(bridge.adapter, {
      schema: SCHEMA_DROP_COLUMN,
      acceptDataLoss: true,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.executedSteps).toBeGreaterThan(0);

    const cols = await pgPushSchema.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='Widget'
    `);
    expect(cols.rows.map((r) => r.column_name)).not.toContain('name');
  });
});

describe('resetSchema', () => {
  // One shared PGlite boot. Each test builds its own PGliteBridge.
  let bridge = new PGliteBridge({ pglite: pgResetSchema });

  afterEach(async () => {
    await bridge.close();
    await pgResetSchema.query('SELECT 1').catch(() => {});
    await resetPublicSchema(pgResetSchema);
    bridge = new PGliteBridge({ pglite: pgResetSchema });
  });

  afterAll(async () => {
    await bridge.close();
    await pgResetSchema.close();
  });

  it('drops tables in non-public user schemas', async () => {
    await pgResetSchema.exec(`
      CREATE SCHEMA base;
      CREATE TABLE base."A" ("id" INT PRIMARY KEY);
      CREATE TABLE public."B" ("id" INT PRIMARY KEY);
    `);

    await resetSchema(bridge.adapter);

    const left = await pgResetSchema.query<{ schemaname: string; tablename: string }>(`
      SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    `);
    expect(left.rows).toEqual([]);
  });

  it('drops all user tables', async () => {
    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
    expect(await listTables(pgResetSchema)).toContain('Widget');

    await resetSchema(bridge.adapter);

    expect(await listTables(pgResetSchema)).not.toContain('Widget');
  });
});

interface RecordedEngineInit {
  init: { datamodels: Array<[string, string]> };
  adapter: object;
}

interface RecordedPushInput {
  force: boolean;
  schema: { files: Array<{ path: string; content: string }> };
}

interface FakePushResult {
  executedSteps: number;
  warnings: string[];
  unexecutable: string[];
}

// Return type stays inferred on purpose: the precise structural type of
// `module` is what makes it assignable to the future SchemaEngineModule.
const makeFakeSchemaEngine = (behavior?: { pushResult?: FakePushResult; pushError?: Error }) => {
  const newCalls: RecordedEngineInit[] = [];
  const pushInputs: RecordedPushInput[] = [];
  const counters = { free: 0 };
  const pushResult = behavior?.pushResult ?? {
    executedSteps: 1,
    warnings: [],
    unexecutable: [],
  };
  const module = {
    SchemaEngine: {
      new: async (
        init: { datamodels: Array<[string, string]> },
        _debugCallback: (msg: string) => void,
        adapter: object,
      ) => {
        newCalls.push({ init, adapter });
        return {
          schemaPush: async (input: object): Promise<FakePushResult> => {
            pushInputs.push(input as RecordedPushInput);
            if (behavior?.pushError) {
              throw behavior.pushError;
            }
            return pushResult;
          },
          free: (): void => {
            counters.free += 1;
          },
        };
      },
    },
  };
  return { module, newCalls, pushInputs, counters };
};

describe('pushSchema with injected schema engine', () => {
  // One shared PGlite boot. The fake engine never actually applies DDL, so
  // afterEach only needs DISCARD ALL (no schema objects to drop).
  let bridge = new PGliteBridge({ pglite: pgInjected });

  afterEach(async () => {
    await bridge.close();
    await pgInjected.query('SELECT 1').catch(() => {});
    await pgInjected.exec('DISCARD ALL');
    bridge = new PGliteBridge({ pglite: pgInjected });
  });

  afterAll(async () => {
    await bridge.close();
    await pgInjected.close();
  });

  it('constructs the injected engine with the schema and bound adapter and returns its result', async () => {
    const fake = makeFakeSchemaEngine({
      pushResult: { executedSteps: 7, warnings: ['careful'], unexecutable: ['nope'] },
    });

    const result = await pushSchema(bridge.adapter, {
      schema: SCHEMA_BASE,
      schemaEngine: fake.module,
    });

    expect(fake.newCalls).toHaveLength(1);
    expect(fake.newCalls[0]?.init.datamodels).toEqual([['schema.prisma', SCHEMA_BASE]]);
    expect(fake.newCalls[0]?.adapter).toBeTypeOf('object');
    expect(fake.newCalls[0]?.adapter).not.toBeNull();
    expect(result).toEqual({
      executedSteps: 7,
      warnings: ['careful'],
      unexecutable: ['nope'],
    });
  });

  it('passes force: false by default and force: true when acceptDataLoss is set', async () => {
    const fake = makeFakeSchemaEngine();

    await pushSchema(bridge.adapter, {
      schema: SCHEMA_BASE,
      schemaEngine: fake.module,
    });
    await pushSchema(bridge.adapter, {
      schema: SCHEMA_BASE,
      acceptDataLoss: true,
      schemaEngine: fake.module,
    });

    expect(fake.pushInputs.map((input) => input.force)).toEqual([false, true]);
  });

  it('frees the engine exactly once when schemaPush rejects', async () => {
    const pushError = new Error('schemaPush exploded');
    const fake = makeFakeSchemaEngine({ pushError });

    await expect(
      pushSchema(bridge.adapter, {
        schema: SCHEMA_BASE,
        schemaEngine: fake.module,
      }),
    ).rejects.toBe(pushError);

    expect(fake.counters.free).toBe(1);
  });

  it('threads the filename option into the datamodels tuple and the pushed schema files', async () => {
    const fake = makeFakeSchemaEngine();

    await pushSchema(bridge.adapter, {
      schema: SCHEMA_BASE,
      filename: 'custom.prisma',
      schemaEngine: fake.module,
    });

    expect(fake.newCalls[0]?.init.datamodels).toEqual([['custom.prisma', SCHEMA_BASE]]);
    expect(fake.pushInputs[0]?.schema.files).toEqual([
      { path: 'custom.prisma', content: SCHEMA_BASE },
    ]);
  });
});
