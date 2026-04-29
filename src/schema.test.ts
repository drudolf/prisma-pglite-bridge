import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterEach, describe, expect, it } from 'vitest';

import { createPgliteAdapter, type PgliteAdapter } from './create-pglite-adapter.ts';
import { createPool } from './create-pool.ts';
import { pushSchema, resetSchema } from './schema.ts';

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

  const makeAdapter = async (): Promise<{ pglite: PGlite; adapter: PgliteAdapter }> => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const adapter = await createPgliteAdapter({ pglite });
    cleanups.push(async () => {
      await adapter.close();
      await pglite.close();
    });
    return { pglite, adapter };
  };

  it('applies a schema and creates tables (PgliteAdapter target)', async () => {
    const { pglite, adapter } = await makeAdapter();

    const result = await pushSchema(adapter, { schema: SCHEMA_BASE });

    expect(result.executedSteps).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    expect(result.unexecutable).toEqual([]);
    expect(await listTables(pglite)).toContain('Widget');
  });

  it('accepts a raw PrismaPg target', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const { pool } = await createPool({ pglite });
    const prismaPg = new PrismaPg(pool);
    cleanups.push(async () => {
      await pool.end();
      await pglite.close();
    });

    const result = await pushSchema(prismaPg, { schema: SCHEMA_BASE });

    expect(result.executedSteps).toBeGreaterThan(0);
    expect(await listTables(pglite)).toContain('Widget');
  });

  it('forceReset drops pre-existing tables before applying', async () => {
    const { pglite, adapter } = await makeAdapter();
    await pglite.exec(`CREATE TABLE legacy ("id" INT PRIMARY KEY)`);
    expect(await listTables(pglite)).toContain('legacy');

    await pushSchema(adapter, { schema: SCHEMA_BASE, forceReset: true });

    const tables = await listTables(pglite);
    expect(tables).toContain('Widget');
    expect(tables).not.toContain('legacy');
  });

  it('returns warnings without throwing for destructive change when acceptDataLoss is false', async () => {
    const { pglite, adapter } = await makeAdapter();
    await pushSchema(adapter, { schema: SCHEMA_BASE });
    await pglite.exec(`INSERT INTO "Widget" ("name") VALUES ('a'), ('b')`);

    const result = await pushSchema(adapter, { schema: SCHEMA_DROP_COLUMN });

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
    const { pglite, adapter } = await makeAdapter();
    await pushSchema(adapter, { schema: SCHEMA_BASE });
    await pglite.exec(`INSERT INTO "Widget" ("name") VALUES ('a'), ('b')`);

    const result = await pushSchema(adapter, {
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
  it('drops all user tables', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    const adapter = await createPgliteAdapter({ pglite });

    try {
      await pushSchema(adapter, { schema: SCHEMA_BASE });
      expect(await listTables(pglite)).toContain('Widget');

      await resetSchema(adapter);

      expect(await listTables(pglite)).not.toContain('Widget');
    } finally {
      await adapter.close();
      await pglite.close();
    }
  });
});
