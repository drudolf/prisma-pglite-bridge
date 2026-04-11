import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './create-test-db.ts';

const { Client } = pg;

describe('createTestDb', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    ctx = await createTestDb({ schemaPath: './prisma/schema.prisma' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('creates a pool backed by PGlite', async () => {
    const client = await ctx.pool.connect();
    const { rows } = await client.query('SELECT 1 AS num');
    expect(rows[0]?.num).toBe(1);
    client.release();
  });

  it('applies schema — tables from schema.prisma exist', async () => {
    const client = await ctx.pool.connect();
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const tables = rows.map((r) => r.tablename);
    expect(tables).toContain('Tenant');
    expect(tables).toContain('Job');
    expect(tables).toContain('Workspace');
    client.release();
  });

  it('truncate() clears all user tables', async () => {
    // Insert data directly via PGlite
    await ctx.pglite.exec(
      `INSERT INTO "Tenant" (id, name, slug) VALUES ('test-id', 'Test', 'test-slug')`,
    );
    const before = await ctx.pglite.query<{ n: number }>('SELECT count(*)::int AS n FROM "Tenant"');
    expect(before.rows[0]?.n).toBe(1);

    await ctx.truncate();

    const after = await ctx.pglite.query<{ n: number }>('SELECT count(*)::int AS n FROM "Tenant"');
    expect(after.rows[0]?.n).toBe(0);
  });

  it('truncate() does not drop tables', async () => {
    await ctx.truncate();

    const { rows } = await ctx.pglite.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'Tenant'",
    );
    expect(rows.length).toBe(1);
  });

  describe('schema resolution', () => {
    it('accepts explicit sql option', async () => {
      const testCtx = await createTestDb({
        sql: 'CREATE TABLE test_explicit (id serial PRIMARY KEY, name text);',
      });

      const { rows } = await testCtx.pglite.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
      );
      expect(rows.map((r) => r.tablename)).toContain('test_explicit');
      await testCtx.close();
    });
  });
});
