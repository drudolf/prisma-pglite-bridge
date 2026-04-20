import { Buffer } from 'node:buffer';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { createTestPgliteAdapter, setupSharedPrismaAdapter } from './__tests__/adapter.ts';

describe('snapshotDb', () => {
  const shared = setupSharedPrismaAdapter({ resetBeforeEach: false });

  it('restores seeded data after resetDb', async () => {
    const prisma = shared.prisma();
    const { resetDb, snapshotDb } = shared.adapter();

    const tenant = await prisma.tenant.create({
      data: { name: 'Snap Tenant', slug: 'snap', labels: ['test'] },
    });
    await prisma.workspace.create({
      data: { name: 'Snap WS', slug: 'snap-ws', tenantId: tenant.id, apiKey: 'key_snap' },
    });

    await snapshotDb();
    await resetDb();

    expect(await prisma.tenant.count()).toBe(1);
    expect(await prisma.workspace.count()).toBe(1);

    const restored = await prisma.tenant.findFirst();
    expect(restored?.slug).toBe('snap');
    expect(restored?.labels).toEqual(['test']);
  });

  it('allows new writes after restore without ID collision', async () => {
    const prisma = shared.prisma();
    const { resetDb } = shared.adapter();

    await resetDb();

    const newTenant = await prisma.tenant.create({
      data: { name: 'New Tenant', slug: 'new-tenant' },
    });
    expect(newTenant.id).toBeDefined();
    expect(await prisma.tenant.count()).toBe(2);
  });

  it('overwrites previous snapshot', async () => {
    const prisma = shared.prisma();
    const { resetDb, snapshotDb } = shared.adapter();

    await resetDb();

    await prisma.tenant.create({
      data: { name: 'Extra Tenant', slug: 'extra' },
    });

    await snapshotDb();
    await resetDb();

    expect(await prisma.tenant.count()).toBe(2);
    const extra = await prisma.tenant.findFirst({ where: { slug: 'extra' } });
    expect(extra).not.toBeNull();
  });

  it('preserves all column types through snapshot cycle', async () => {
    const prisma = shared.prisma();
    const { resetDb, snapshotDb } = shared.adapter();

    await resetDb();

    const ws = await prisma.workspace.findFirstOrThrow();

    const job = await prisma.job.create({
      data: {
        friendlyId: 'j_snap',
        workspaceId: ws.id,
        payload: { model: 'gpt-4', temperature: 0.7 },
        tags: ['snapshot', 'test'],
      },
    });

    const entry = await prisma.catalogEntry.create({
      data: { friendlyId: 'ce_snap', name: 'snap-model', pattern: '.*', provider: 'test' },
    });
    const tier = await prisma.catalogTier.create({
      data: { name: 'Snap Tier', isDefault: true, entryId: entry.id },
    });
    await prisma.catalogPrice.create({
      data: { kind: 'input', amount: '0.000025000000', tierId: tier.id },
    });

    const blobContent = Buffer.from('snapshot-binary-data');
    await prisma.blob.create({
      data: { name: 'snap.bin', data: blobContent, size: blobContent.length },
    });

    await snapshotDb();
    await resetDb();

    const restoredJob = await prisma.job.findUnique({ where: { id: job.id } });
    expect((restoredJob?.payload as Record<string, unknown>).model).toBe('gpt-4');
    expect(restoredJob?.tags).toEqual(['snapshot', 'test']);

    const restoredPrice = await prisma.catalogPrice.findFirst();
    expect(Number(restoredPrice?.amount)).toBeCloseTo(0.000025, 12);

    const restoredBlob = await prisma.blob.findFirst();
    expect(Buffer.from(restoredBlob?.data as Buffer).toString()).toBe('snapshot-binary-data');
  });

  it('resetSnapshot clears snapshot, resetDb truncates to empty', async () => {
    const prisma = shared.prisma();
    const { resetDb, resetSnapshot } = shared.adapter();

    await resetSnapshot();
    await resetDb();

    expect(await prisma.tenant.count()).toBe(0);
  });

  it('restores rows from non-public and quoted-identifier tables', async () => {
    const { pglite, snapshotDb, resetDb, close } = await createTestPgliteAdapter({
      sql: 'CREATE TABLE baseline (id int PRIMARY KEY)',
    });

    try {
      await pglite.exec('CREATE SCHEMA extra');
      await pglite.exec(
        'CREATE TABLE extra.snapshot_test (id int PRIMARY KEY, name text NOT NULL)',
      );
      await pglite.exec("INSERT INTO extra.snapshot_test VALUES (1, 'seed')");

      await pglite.exec('CREATE SCHEMA "s\'q"');
      await pglite.exec('CREATE TABLE "s\'q"."t\'q" (id int PRIMARY KEY, name text NOT NULL)');
      await pglite.exec('INSERT INTO "s\'q"."t\'q" VALUES (1, \'seed\')');

      await snapshotDb();

      await pglite.exec(
        "DELETE FROM extra.snapshot_test; INSERT INTO extra.snapshot_test VALUES (2, 'changed')",
      );
      await pglite.exec('DELETE FROM "s\'q"."t\'q"');
      await resetDb();

      const extraRows = await pglite.query<{ id: number; name: string }>(
        'SELECT id, name FROM extra.snapshot_test ORDER BY id',
      );
      expect(extraRows.rows).toEqual([{ id: 1, name: 'seed' }]);

      const { rows } = await pglite.query<{ id: number; name: string }>(
        'SELECT id, name FROM "s\'q"."t\'q" ORDER BY id',
      );
      expect(rows).toEqual([{ id: 1, name: 'seed' }]);
    } finally {
      await close();
    }
  });
});

describe('snapshot with auto-increment sequences', () => {
  it('preserves and restores used and unused sequence positions', async () => {
    const { adapter, resetDb, snapshotDb, close } = await createTestPgliteAdapter({
      sql: [
        'CREATE TABLE counter (id serial PRIMARY KEY, label text NOT NULL)',
        'CREATE TABLE counter_unused (id serial PRIMARY KEY, label text NOT NULL)',
      ].join(';\n'),
    });
    const prisma = new PrismaClient({ adapter });
    try {
      await prisma.$queryRawUnsafe("INSERT INTO counter (label) VALUES ('a'), ('b'), ('c')");

      await snapshotDb();

      await prisma.$queryRawUnsafe("INSERT INTO counter_unused (label) VALUES ('after-snapshot')");
      await resetDb();

      const rows = await prisma.$queryRawUnsafe<{ id: number; label: string }[]>(
        'SELECT * FROM counter ORDER BY id',
      );
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.label)).toEqual(['a', 'b', 'c']);

      await prisma.$queryRawUnsafe("INSERT INTO counter (label) VALUES ('d')");
      const next = await prisma.$queryRawUnsafe<{ id: number }[]>(
        "SELECT id FROM counter WHERE label = 'd'",
      );
      expect(next[0]?.id).toBe(4);

      await prisma.$queryRawUnsafe("INSERT INTO counter_unused (label) VALUES ('after-reset')");
      const unusedRows = await prisma.$queryRawUnsafe<{ id: number; label: string }[]>(
        'SELECT id, label FROM counter_unused ORDER BY id',
      );
      expect(unusedRows).toEqual([{ id: 1, label: 'after-reset' }]);
    } finally {
      await prisma.$disconnect();
      await close();
    }
  });
});

describe('backwards compat: resetDb without snapshot still truncates', () => {
  const shared = setupSharedPrismaAdapter();

  it('truncates to empty when no snapshot exists', async () => {
    const prisma = shared.prisma();
    const { resetDb } = shared.adapter();

    await prisma.tenant.create({
      data: { name: 'Compat Tenant', slug: 'compat' },
    });
    expect(await prisma.tenant.count()).toBe(1);

    await resetDb();

    expect(await prisma.tenant.count()).toBe(0);
  });

  it('resetDb truncates and restarts serial sequences even without a snapshot', async () => {
    const { adapter, resetDb, close } = await createTestPgliteAdapter({
      sql: 'CREATE TABLE counter (id serial PRIMARY KEY, label text NOT NULL)',
    });
    const prisma = new PrismaClient({ adapter });

    try {
      await prisma.$queryRawUnsafe("INSERT INTO counter (label) VALUES ('before-reset')");
      await resetDb();
      await prisma.$queryRawUnsafe("INSERT INTO counter (label) VALUES ('after-reset')");

      const rows = await prisma.$queryRawUnsafe<{ id: number }[]>(
        "SELECT id FROM counter WHERE label = 'after-reset'",
      );
      expect(rows[0]?.id).toBe(1);
    } finally {
      await prisma.$disconnect();
      await close();
    }
  });
});
