import { PrismaClient } from '@prisma/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { createPgliteAdapter } from './create-test-db.ts';

describe('createPgliteAdapter', () => {
  let adapter: Awaited<ReturnType<typeof createPgliteAdapter>>['adapter'];
  let resetDb: Awaited<ReturnType<typeof createPgliteAdapter>>['resetDb'];
  let prisma: PrismaClient;

  beforeAll(async () => {
    ({ adapter, resetDb } = await createPgliteAdapter({ schemaPath: './prisma/schema.prisma' }));
    prisma = new PrismaClient({ adapter });
  });

  it('adapter works with PrismaClient', async () => {
    const tenant = await prisma.tenant.create({ data: { name: 'Test', slug: 'test' } });
    expect(tenant.id).toBeDefined();
  });

  it('applies schema — tables from schema.prisma exist', async () => {
    const tenants = await prisma.tenant.findMany();
    expect(tenants.length).toBeGreaterThan(0);
  });

  it('resetDb() clears all user tables', async () => {
    await prisma.tenant.create({ data: { name: 'Before', slug: `before-${Date.now()}` } });
    const before = await prisma.tenant.count();
    expect(before).toBeGreaterThan(0);

    await resetDb();

    const after = await prisma.tenant.count();
    expect(after).toBe(0);
  });

  it('resetDb() does not drop tables', async () => {
    await resetDb();
    // Table still exists — create works after reset
    const tenant = await prisma.tenant.create({ data: { name: 'After', slug: 'after-reset' } });
    expect(tenant.id).toBeDefined();
  });

  describe('schema resolution', () => {
    it('accepts explicit sql option', async () => {
      const { adapter: sqlAdapter } = await createPgliteAdapter({
        sql: 'CREATE TABLE test_explicit (id serial PRIMARY KEY, name text);',
      });
      const sqlPrisma = new PrismaClient({ adapter: sqlAdapter });
      await sqlPrisma.$queryRawUnsafe('INSERT INTO test_explicit (name) VALUES ($1)', 'hello');
      const rows = await sqlPrisma.$queryRawUnsafe<{ name: string }[]>(
        'SELECT name FROM test_explicit',
      );
      expect(rows[0]).toHaveProperty('name', 'hello');
    });
  });
});
