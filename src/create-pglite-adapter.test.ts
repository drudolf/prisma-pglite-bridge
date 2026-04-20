import { Buffer } from 'node:buffer';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  createTestPgliteAdapter,
  setupSharedPrismaAdapter,
  withAdapter,
  withTempDataDir,
} from './__tests__/adapter.ts';

// ─── Helpers ───

const shared = setupSharedPrismaAdapter();

const createTenant = (slug = 'test-tenant') =>
  shared.prisma().tenant.create({ data: { name: 'Test Tenant', slug } });

const createWorkspace = (tenantId: string, slug = 'test-ws') =>
  shared.prisma().workspace.create({
    data: { name: 'Test WS', slug, tenantId, apiKey: `key_${slug}_${Date.now()}` },
  });

// ─── Adapter lifecycle ───

describe('createPgliteAdapter', () => {
  it('adapter works with PrismaClient', async () => {
    const tenant = await createTenant();
    expect(tenant.id).toBeDefined();
  });

  it('resetDb() clears all user tables', async () => {
    const { resetDb } = shared.adapter();
    await createTenant(`before-${Date.now()}`);
    expect(await shared.prisma().tenant.count()).toBeGreaterThan(0);

    await resetDb();

    expect(await shared.prisma().tenant.count()).toBe(0);
  });

  it('resetDb() does not drop tables', async () => {
    const { resetDb } = shared.adapter();
    await resetDb();
    const tenant = await createTenant('after-reset');
    expect(tenant.id).toBeDefined();
  });

  it('accepts explicit sql option', async () => {
    const { adapter: sqlAdapter, close } = await createTestPgliteAdapter({
      sql: 'CREATE TABLE test_explicit (id serial PRIMARY KEY, name text);',
    });
    const sqlPrisma = new PrismaClient({ adapter: sqlAdapter });
    try {
      await sqlPrisma.$queryRawUnsafe('INSERT INTO test_explicit (name) VALUES ($1)', 'hello');
      const rows = await sqlPrisma.$queryRawUnsafe<{ name: string }[]>(
        'SELECT name FROM test_explicit',
      );
      expect(rows[0]).toHaveProperty('name', 'hello');
    } finally {
      await sqlPrisma.$disconnect();
      await close();
    }
  });

  it('reopens an existing dataDir without replaying schema SQL', async () => {
    const sql = 'CREATE TABLE persisted (id serial PRIMARY KEY, name text NOT NULL)';
    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async (first) => {
        await first.pglite.exec("INSERT INTO persisted (name) VALUES ('first-run')");
      });
      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM persisted',
        );
        expect(rows[0]?.n).toBe(1);
      });
    });
  });

  it('reopens an existing dataDir when the schema SQL created only non-table objects', async () => {
    const sql = "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')";
    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async () => {});
      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_type WHERE typname = 'mood'",
        );
        expect(rows[0]?.n).toBe(1);
      });
    });
  });

  it('reopens an existing dataDir when the schema SQL created only sequences', async () => {
    const sql = 'CREATE SEQUENCE custom_seq START 5';
    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async () => {});
      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname = 'custom_seq'",
        );
        expect(rows[0]?.n).toBe(1);
      });
    });
  });

  it('reopens an existing dataDir without requiring schema SQL resolution', async () => {
    await withTempDataDir(async (dataDir) => {
      await withAdapter(
        { dataDir, sql: 'CREATE TABLE persisted (id int PRIMARY KEY)' },
        async (first) => {
          await first.pglite.exec('INSERT INTO persisted VALUES (1)');
        },
      );
      await withAdapter({ dataDir, configRoot: '/definitely/not/here' }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM persisted',
        );
        expect(rows[0]?.n).toBe(1);
      });
    });
  });

  it('reopens an existing dataDir when the schema SQL created only non-public tables', async () => {
    const sql = 'CREATE SCHEMA extra; CREATE TABLE extra.persisted (id int PRIMARY KEY)';
    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async (first) => {
        await first.pglite.exec('INSERT INTO extra.persisted VALUES (1)');
      });
      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM extra.persisted',
        );
        expect(rows[0]?.n).toBe(1);
      });
    });
  });

  it('resetDb also clears tables created after the first reset', async () => {
    const { pglite, resetDb, close } = await createTestPgliteAdapter();

    try {
      await resetDb();
      await pglite.exec('CREATE TABLE late_table (id int PRIMARY KEY)');
      await pglite.exec('INSERT INTO late_table VALUES (1)');

      await resetDb();

      const { rows } = await pglite.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM late_table',
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      await close();
    }
  });
});

// ─── Enum columns ───

describe('enum columns', () => {
  it('stores and retrieves enum values', async () => {
    const tenant = await createTenant();
    const user = await shared.prisma().tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'user-1', role: 'ADMIN' },
    });
    expect(user.role).toBe('ADMIN');
  });

  it('filters by enum value', async () => {
    const tenant = await createTenant();
    await shared.prisma().tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'u1', role: 'ADMIN' },
    });
    await shared.prisma().tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'u2', role: 'MEMBER' },
    });
    await shared.prisma().tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'u3', role: 'MEMBER' },
    });
    const admins = await shared.prisma().tenantUser.findMany({ where: { role: 'ADMIN' } });
    expect(admins).toHaveLength(1);
  });

  it('updates enum value (status transition)', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const job = await shared.prisma().job.create({
      data: { friendlyId: 'job_1', workspaceId: ws.id },
    });
    expect(job.status).toBe('DRAFT');

    const updated = await shared.prisma().job.update({
      where: { id: job.id },
      data: { status: 'ACTIVE', startedAt: new Date() },
    });
    expect(updated.status).toBe('ACTIVE');
    expect(updated.startedAt).toBeInstanceOf(Date);
  });
});

// ─── Json and JsonB ───

describe('Json and JsonB columns', () => {
  it('stores and retrieves Json objects', async () => {
    const tenant = await createTenant();
    const updated = await shared.prisma().tenant.update({
      where: { id: tenant.id },
      data: { config: { theme: 'dark', notifications: { email: true, slack: false } } },
    });
    expect((updated.config as Record<string, unknown>).theme).toBe('dark');
  });

  it('stores explicit JsonB', async () => {
    const tenant = await createTenant();
    const updated = await shared.prisma().tenant.update({
      where: { id: tenant.id },
      data: { flags: { betaAccess: true, maxJobs: 1000 } },
    });
    expect((updated.flags as Record<string, unknown>).betaAccess).toBe(true);
  });

  it('handles null Json correctly', async () => {
    const tenant = await createTenant();
    expect(tenant.config).toBeNull();
    expect(tenant.flags).toBeNull();
  });

  it('stores Json arrays', async () => {
    const entry = await shared.prisma().catalogEntry.create({
      data: { friendlyId: 'ce_1', name: 'test', pattern: '.*', provider: 'openai' },
    });
    const tier = await shared.prisma().catalogTier.create({
      data: {
        name: 'Standard',
        isDefault: true,
        conditions: [{ region: 'us-east-1' }, { region: 'eu-west-1' }],
        entryId: entry.id,
      },
    });
    const fetched = await shared.prisma().catalogTier.findUnique({ where: { id: tier.id } });
    expect(Array.isArray(fetched?.conditions)).toBe(true);
    expect((fetched?.conditions as unknown[])?.length).toBe(2);
  });
});

// ─── Decimal precision ───

describe('Decimal precision', () => {
  it('preserves Decimal(6,2) precision', async () => {
    const tenant = await createTenant();
    const ws = await shared.prisma().workspace.create({
      data: {
        name: 'Precision WS',
        slug: 'precision',
        tenantId: tenant.id,
        apiKey: 'key_precision',
        rateLimit: '3.75',
      },
    });
    const fetched = await shared.prisma().workspace.findUnique({ where: { id: ws.id } });
    expect(Number(fetched?.rateLimit)).toBeCloseTo(3.75, 2);
  });

  it('preserves Decimal(20,12) high precision', async () => {
    const entry = await shared.prisma().catalogEntry.create({
      data: { friendlyId: 'ce_dec', name: 'gpt-4', pattern: '^gpt-4$', provider: 'openai' },
    });
    const tier = await shared.prisma().catalogTier.create({
      data: { name: 'Default', isDefault: true, entryId: entry.id },
    });
    const price = await shared.prisma().catalogPrice.create({
      data: { kind: 'input', amount: '0.000025000000', tierId: tier.id },
    });
    const fetched = await shared.prisma().catalogPrice.findUnique({ where: { id: price.id } });
    expect(Number(fetched?.amount)).toBeCloseTo(0.000025, 12);
  });
});

// ─── String[] arrays ───

describe('String[] arrays', () => {
  it('stores and retrieves string arrays', async () => {
    const tenant = await createTenant();
    const updated = await shared.prisma().tenant.update({
      where: { id: tenant.id },
      data: { labels: ['production', 'us-east', 'tier-1'] },
    });
    expect(updated.labels).toEqual(['production', 'us-east', 'tier-1']);
  });

  it('defaults to empty array', async () => {
    const tenant = await createTenant();
    expect(tenant.labels).toEqual([]);
  });

  it('handles array has filter', async () => {
    const tenant = await createTenant(`array-tenant-${Date.now()}`);
    const ws = await createWorkspace(tenant.id, `array-ws-${Date.now()}`);

    await shared.prisma().job.createMany({
      data: [
        { friendlyId: 'j1', workspaceId: ws.id, tags: ['urgent', 'api'] },
        { friendlyId: 'j2', workspaceId: ws.id, tags: ['batch', 'api'] },
        { friendlyId: 'j3', workspaceId: ws.id, tags: ['batch'] },
      ],
    });

    const urgent = await shared.prisma().job.findMany({ where: { tags: { has: 'urgent' } } });
    expect(urgent).toHaveLength(1);

    const api = await shared.prisma().job.findMany({ where: { tags: { has: 'api' } } });
    expect(api).toHaveLength(2);
  });
});

// ─── Bytes (binary data) ───

describe('Bytes (binary data)', () => {
  it('stores and retrieves binary data', async () => {
    const content = Buffer.from('Hello, binary world!');
    const blob = await shared.prisma().blob.create({
      data: { name: 'test.txt', data: content, size: content.length },
    });
    const fetched = await shared.prisma().blob.findUnique({ where: { id: blob.id } });
    expect(Buffer.from(fetched?.data as Buffer).toString()).toBe('Hello, binary world!');
  });

  it('handles large binary data', async () => {
    const content = Buffer.alloc(64 * 1024, 0xab);
    const blob = await shared.prisma().blob.create({
      data: { name: 'large.bin', data: content, size: content.length },
    });
    const fetched = await shared.prisma().blob.findUnique({ where: { id: blob.id } });
    expect((fetched?.data as Buffer).length).toBe(65536);
    expect(Buffer.from(fetched?.data as Buffer)[0]).toBe(0xab);
  });
});

// ─── Nested creates ───

describe('nested creates with relations', () => {
  it('creates parent with nested children', async () => {
    const entry = await shared.prisma().catalogEntry.create({
      data: {
        friendlyId: 'ce_nested',
        name: 'gpt-4o',
        pattern: '^gpt-4o$',
        provider: 'openai',
        capabilities: ['chat', 'vision', 'function-calling'],
        tiers: {
          create: {
            name: 'Standard',
            isDefault: true,
            prices: {
              create: [
                { kind: 'input', amount: '0.000005' },
                { kind: 'output', amount: '0.000015' },
              ],
            },
          },
        },
      },
      include: { tiers: { include: { prices: true } } },
    });

    expect(entry.tiers).toHaveLength(1);
    expect(entry.tiers[0]?.prices).toHaveLength(2);
    expect(entry.capabilities).toEqual(['chat', 'vision', 'function-calling']);
  });
});

// ─── Deep include ───

describe('findFirst/findMany with deep include', () => {
  it('loads nested relations', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const job = await shared.prisma().job.create({
      data: {
        friendlyId: 'j_deep',
        workspaceId: ws.id,
        status: 'ACTIVE',
        attempts: {
          create: [
            { number: 1, status: 'ARCHIVED' },
            { number: 2, status: 'ACTIVE' },
          ],
        },
      },
    });

    await shared.prisma().dependency.create({
      data: { friendlyId: 'dep_1', type: 'manual', jobId: job.id },
    });

    const depCheck = await shared.prisma().dependency.findMany({ where: { jobId: job.id } });
    expect(depCheck).toHaveLength(1);

    const withTwo = await shared.prisma().job.findUnique({
      where: { id: job.id },
      include: { attempts: { orderBy: { number: 'asc' } }, workspace: true },
    });
    expect(withTwo?.attempts).toHaveLength(2);
    expect(withTwo?.attempts[0]?.number).toBe(1);

    const withDeep = await shared.prisma().job.findUnique({
      where: { id: job.id },
      include: { workspace: { include: { tenant: true } } },
    });
    expect(withDeep?.workspace?.tenant?.slug).toBe('test-tenant');

    const deps = await shared.prisma().dependency.findMany({ where: { jobId: job.id } });
    expect(deps).toHaveLength(1);
    expect(deps[0]?.type).toBe('manual');
  });
});

// ─── Upsert on composite unique ───

describe('upsert on composite unique', () => {
  it('creates on first call, updates on second', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    const created = await shared.prisma().channel.upsert({
      where: { workspaceId_name: { workspaceId: ws.id, name: 'default' } },
      create: {
        friendlyId: 'ch_1',
        name: 'default',
        concurrencyLimit: 10,
        workspaceId: ws.id,
      },
      update: { concurrencyLimit: 20 },
    });
    expect(created.concurrencyLimit).toBe(10);

    const updated = await shared.prisma().channel.upsert({
      where: { workspaceId_name: { workspaceId: ws.id, name: 'default' } },
      create: {
        friendlyId: 'ch_1_dup',
        name: 'default',
        concurrencyLimit: 10,
        workspaceId: ws.id,
      },
      update: { concurrencyLimit: 20 },
    });
    expect(updated.concurrencyLimit).toBe(20);
    expect(updated.id).toBe(created.id);
  });
});

// ─── Cascading deletes ───

describe('cascading deletes', () => {
  it('deletes children when parent is deleted', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const job = await shared.prisma().job.create({
      data: {
        friendlyId: 'j_cascade',
        workspaceId: ws.id,
        attempts: { create: [{ number: 1 }, { number: 2 }] },
        snapshots: { create: { data: { checkpoint: true } } },
      },
    });

    await shared.prisma().job.delete({ where: { id: job.id } });

    const attempts = await shared.prisma().attempt.findMany({ where: { jobId: job.id } });
    const snapshots = await shared.prisma().snapshot.findMany({ where: { jobId: job.id } });
    expect(attempts).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });
});

// ─── Nullable field semantics ───

describe('nullable field semantics', () => {
  it('distinguishes null from undefined on update', async () => {
    const entry = await shared.prisma().catalogEntry.create({
      data: {
        friendlyId: 'ce_null',
        name: 'test',
        pattern: '.*',
        provider: 'test',
        baseName: 'original-base',
      },
    });
    expect(entry.baseName).toBe('original-base');

    const cleared = await shared.prisma().catalogEntry.update({
      where: { id: entry.id },
      data: { baseName: null },
    });
    expect(cleared.baseName).toBeNull();

    const fetched = await shared.prisma().catalogEntry.findUnique({ where: { id: entry.id } });
    expect(fetched?.baseName).toBeNull();
  });

  it('omitting a field in update does not clear it', async () => {
    const entry = await shared.prisma().catalogEntry.create({
      data: {
        friendlyId: 'ce_omit',
        name: 'test',
        pattern: '.*',
        provider: 'test',
        description: 'keep this',
      },
    });

    await shared.prisma().catalogEntry.update({
      where: { id: entry.id },
      data: { name: 'updated' },
    });

    const fetched = await shared.prisma().catalogEntry.findUnique({ where: { id: entry.id } });
    expect(fetched?.description).toBe('keep this');
  });
});

// ─── Batch operations ───

describe('batch operations', () => {
  it('createMany and count', async () => {
    const tenant = await createTenant(`batch-tenant-${Date.now()}`);
    const ws = await createWorkspace(tenant.id, `batch-ws-${Date.now()}`);

    const { count } = await shared.prisma().job.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        friendlyId: `batch_${i}`,
        workspaceId: ws.id,
        priority: i % 5,
      })),
    });
    expect(count).toBe(50);

    const total = await shared.prisma().job.count({ where: { workspaceId: ws.id } });
    expect(total).toBe(50);
  });

  it('batch relation (jobs in a batch)', async () => {
    const tenant = await createTenant(`batch-rel-tenant-${Date.now()}`);
    const ws = await createWorkspace(tenant.id, `batch-rel-ws-${Date.now()}`);
    const batch = await shared.prisma().batch.create({
      data: { friendlyId: 'batch_1' },
    });

    await shared.prisma().job.createMany({
      data: [
        { friendlyId: 'bj_1', workspaceId: ws.id, batchId: batch.id },
        { friendlyId: 'bj_2', workspaceId: ws.id, batchId: batch.id },
      ],
    });

    const found = await shared.prisma().batch.findUnique({
      where: { id: batch.id },
      include: { jobs: true },
    });
    expect(found?.jobs).toHaveLength(2);
  });
});

// ─── Timestamps ───

describe('updatedAt auto-generation', () => {
  it('sets updatedAt on create and update', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const job = await shared.prisma().job.create({
      data: { friendlyId: 'j_ts', workspaceId: ws.id },
    });
    const createdUpdatedAt = job.updatedAt;
    expect(createdUpdatedAt).toBeInstanceOf(Date);

    const forcedPastUpdatedAt = new Date('2000-01-01T00:00:00.000Z');
    await shared
      .prisma()
      .$executeRawUnsafe(
        'UPDATE "Job" SET "updatedAt" = $1 WHERE "id" = $2',
        forcedPastUpdatedAt,
        job.id,
      );

    const updated = await shared.prisma().job.update({
      where: { id: job.id },
      data: { status: 'ACTIVE' },
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(forcedPastUpdatedAt.getTime());
  });
});

// ─── Transactions ───

describe('transactions', () => {
  it('commits on success', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    await shared.prisma().$transaction(async (tx) => {
      await tx.job.create({ data: { friendlyId: 'tx_1', workspaceId: ws.id } });
      await tx.job.create({ data: { friendlyId: 'tx_2', workspaceId: ws.id } });
    });

    const count = await shared.prisma().job.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(2);
  });

  it('commits with SERIALIZABLE isolation level', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    await shared.prisma().$transaction(
      async (tx) => {
        await tx.job.create({ data: { friendlyId: 'iso_1', workspaceId: ws.id } });
        await tx.job.create({ data: { friendlyId: 'iso_2', workspaceId: ws.id } });
      },
      { isolationLevel: 'Serializable' },
    );

    const count = await shared.prisma().job.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(2);
  });

  it('rolls back on error', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    await expect(
      shared.prisma().$transaction(async (tx) => {
        await tx.job.create({ data: { friendlyId: 'tx_fail_1', workspaceId: ws.id } });
        await tx.job.create({ data: { friendlyId: 'tx_fail_1', workspaceId: ws.id } });
      }),
    ).rejects.toThrow();

    const count = await shared.prisma().job.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
  });
});

// ─── Ordering ───

describe('ordering and sorted indexes', () => {
  it('orders by descending createdAt using sorted index', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const baseTime = new Date('2024-01-01T00:00:00.000Z').getTime();

    for (let i = 0; i < 5; i++) {
      await shared.prisma().job.create({
        data: {
          friendlyId: `ord_${i}`,
          workspaceId: ws.id,
          priority: i,
          createdAt: new Date(baseTime + i * 1_000),
        },
      });
    }

    const jobs = await shared.prisma().job.findMany({
      where: { workspaceId: ws.id },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });

    expect(jobs).toHaveLength(3);
    expect(jobs[0]?.friendlyId).toBe('ord_4');
    expect(jobs[2]?.friendlyId).toBe('ord_2');
  });
});

// ─── Many-to-many ───

describe('many-to-many implicit relations', () => {
  it('connects and queries through join table', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    const channel = await shared.prisma().channel.create({
      data: { friendlyId: 'ch_m2m', name: 'events', workspaceId: ws.id },
    });

    await shared.prisma().item.create({
      data: {
        key: 'item-1',
        value: { data: 'hello' },
        workspaceId: ws.id,
        channels: { connect: { id: channel.id } },
      },
    });
    await shared.prisma().item.create({
      data: {
        key: 'item-2',
        value: { data: 'world' },
        workspaceId: ws.id,
        channels: { connect: { id: channel.id } },
      },
    });

    const found = await shared.prisma().channel.findUnique({
      where: { id: channel.id },
      include: { items: true },
    });
    expect(found?.items).toHaveLength(2);
  });
});
