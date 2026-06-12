import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, describe, expect, it } from 'vitest';
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

describe('pushSchema', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn?.();
    }
  });

  const makeBridge = async (): Promise<{ pglite: PGlite; bridge: PGliteBridge }> => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const bridge = new PGliteBridge({ pglite });
    cleanups.push(async () => {
      await bridge.close();
    });
    return { pglite, bridge };
  };

  it('applies a schema and creates tables (PGliteBridge target)', async () => {
    const { pglite, bridge } = await makeBridge();

    const result = await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });

    expect(result.executedSteps).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(result.unexecutable).toEqual([]);
    expect(await listTables(pglite)).toContain('Widget');
  });

  it('accepts a raw PrismaPg target', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const pool = new PgBridgePool({ pglite });
    const prismaPg = new PrismaPg(pool);
    cleanups.push(async () => {
      await pool.end();
      await pglite.close();
    });

    const result = await pushSchema(prismaPg, { schema: SCHEMA_BASE, forceReset: true });

    expect(result.executedSteps).toBeGreaterThan(0);
    expect(await listTables(pglite)).toContain('Widget');
  });

  it('forceReset drops pre-existing tables before applying', async () => {
    const { pglite, bridge } = await makeBridge();
    await pglite.exec(`CREATE TABLE legacy ("id" INT PRIMARY KEY)`);
    expect(await listTables(pglite)).toContain('legacy');

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    const tables = await listTables(pglite);
    expect(tables).toContain('Widget');
    expect(tables).not.toContain('legacy');
  });

  it('forceReset clears snapshot manager state', async () => {
    const { pglite, bridge } = await makeBridge();
    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
    await pglite.exec(`INSERT INTO "Widget" ("name") VALUES ('seed')`);
    await bridge.snapshotDb();

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    await expect(bridge.resetDb()).resolves.toBeUndefined();
  });

  it('forceReset handles schema names containing semicolons', async () => {
    const { pglite, bridge } = await makeBridge();
    await pglite.exec(`CREATE SCHEMA "semi;name"`);
    await pglite.exec(`CREATE TABLE "semi;name"."t" ("id" INT PRIMARY KEY)`);

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    const left = await pglite.query<{ schemaname: string }>(`
      SELECT schemaname FROM pg_tables WHERE schemaname = 'semi;name'
    `);
    expect(left.rows).toEqual([]);
  });

  it('forceReset drops tables in non-public user schemas', async () => {
    const { pglite, bridge } = await makeBridge();
    await pglite.exec(`
      CREATE SCHEMA base;
      CREATE TABLE base."A" ("id" INT PRIMARY KEY);
    `);

    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE, forceReset: true });

    const left = await pglite.query<{ schemaname: string; tablename: string }>(`
      SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    `);
    const inBase = left.rows.filter((r) => r.schemaname === 'base');
    expect(inBase).toEqual([]);
  });

  it('returns warnings without throwing for destructive change when acceptDataLoss is false', async () => {
    const { pglite, bridge } = await makeBridge();
    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
    await pglite.exec(`INSERT INTO "Widget" ("name") VALUES ('a'), ('b')`);

    const result = await pushSchema(bridge.adapter, { schema: SCHEMA_DROP_COLUMN });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.unexecutable).toEqual([]);
    expect(result.executedSteps).toBe(0);

    const cols = await pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='Widget'
    `);
    expect(cols.rows.map((r) => r.column_name)).toContain('name');
  });

  it('applies destructive change with acceptDataLoss=true', async () => {
    const { pglite, bridge } = await makeBridge();
    await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
    await pglite.exec(`INSERT INTO "Widget" ("name") VALUES ('a'), ('b')`);

    const result = await pushSchema(bridge.adapter, {
      schema: SCHEMA_DROP_COLUMN,
      acceptDataLoss: true,
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.executedSteps).toBeGreaterThan(0);

    const cols = await pglite.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='Widget'
    `);
    expect(cols.rows.map((r) => r.column_name)).not.toContain('name');
  });
});

describe('resetSchema', () => {
  it('drops tables in non-public user schemas', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const bridge = new PGliteBridge({ pglite });
    try {
      await pglite.exec(`
        CREATE SCHEMA base;
        CREATE TABLE base."A" ("id" INT PRIMARY KEY);
        CREATE TABLE public."B" ("id" INT PRIMARY KEY);
      `);

      await resetSchema(bridge.adapter);

      const left = await pglite.query<{ schemaname: string; tablename: string }>(`
        SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      `);
      expect(left.rows).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  it('drops all user tables', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const bridge = new PGliteBridge({ pglite });

    try {
      await pushSchema(bridge.adapter, { schema: SCHEMA_BASE });
      expect(await listTables(pglite)).toContain('Widget');

      await resetSchema(bridge.adapter);

      expect(await listTables(pglite)).not.toContain('Widget');
    } finally {
      await bridge.close();
    }
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
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn?.();
    }
  });

  const makeBridge = async (): Promise<{ pglite: PGlite; bridge: PGliteBridge }> => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const bridge = new PGliteBridge({ pglite });
    cleanups.push(async () => {
      await bridge.close();
    });
    return { pglite, bridge };
  };

  it('constructs the injected engine with the schema and bound adapter and returns its result', async () => {
    const { bridge } = await makeBridge();
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
    const { bridge } = await makeBridge();
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
    const { bridge } = await makeBridge();
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
    const { bridge } = await makeBridge();
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
