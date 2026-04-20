import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PgliteAdapter,
  ResetDbFn,
  ResetSnapshotFn,
  SnapshotDbFn,
} from './create-pglite-adapter.ts';
import { createPgliteAdapter } from './create-pglite-adapter.ts';
import type { StatsLevel } from './stats-collector.ts';

let prisma: PrismaClient;
let resetDb: ResetDbFn;
let closeSharedAdapter: (() => Promise<void>) | undefined;

beforeAll(async () => {
  let adapter: PgliteAdapter['adapter'];
  ({ adapter, resetDb, close: closeSharedAdapter } = await createPgliteAdapter());
  prisma = new PrismaClient({ adapter });
});

afterAll(async () => {
  await prisma.$disconnect();
  await closeSharedAdapter?.();
  await settleAsync();
});

beforeEach(() => resetDb());

// ─── Helpers ───

const createTenant = (slug = 'test-tenant') =>
  prisma.tenant.create({ data: { name: 'Test Tenant', slug } });

const createWorkspace = (tenantId: string, slug = 'test-ws') =>
  prisma.workspace.create({
    data: { name: 'Test WS', slug, tenantId, apiKey: `key_${slug}_${Date.now()}` },
  });

const createTempDataDir = () => mkdtempSync(join(tmpdir(), 'prisma-pglite-bridge-'));

const settleAsync = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const withTempDataDir = async (fn: (dataDir: string) => Promise<void>) => {
  const dataDir = createTempDataDir();
  try {
    await fn(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
};

const withAdapter = async (
  opts: Parameters<typeof createPgliteAdapter>[0],
  fn: (result: Awaited<ReturnType<typeof createPgliteAdapter>>) => Promise<void>,
) => {
  const result = await createPgliteAdapter(opts);
  try {
    await fn(result);
  } finally {
    await result.close();
  }
};

const withPrismaAdapter = async (
  opts: Parameters<typeof createPgliteAdapter>[0],
  fn: (
    prismaClient: PrismaClient,
    result: Awaited<ReturnType<typeof createPgliteAdapter>>,
  ) => Promise<void>,
) => {
  const result = await createPgliteAdapter(opts);
  const prismaClient = new PrismaClient({ adapter: result.adapter });
  try {
    await fn(prismaClient, result);
  } finally {
    await prismaClient.$disconnect();
    await result.close();
    await settleAsync();
  }
};

// ─── Adapter lifecycle ───

describe('createPgliteAdapter', () => {
  it('adapter works with PrismaClient', async () => {
    const tenant = await createTenant();
    expect(tenant.id).toBeDefined();
  });

  it('resetDb() clears all user tables', async () => {
    await createTenant(`before-${Date.now()}`);
    expect(await prisma.tenant.count()).toBeGreaterThan(0);

    await resetDb();

    expect(await prisma.tenant.count()).toBe(0);
  });

  it('resetDb() does not drop tables', async () => {
    await resetDb();
    const tenant = await createTenant('after-reset');
    expect(tenant.id).toBeDefined();
  });

  it('accepts explicit sql option', async () => {
    const { adapter: sqlAdapter, close } = await createPgliteAdapter({
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
    const { pglite, resetDb, close } = await createPgliteAdapter();

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
    const user = await prisma.tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'user-1', role: 'ADMIN' },
    });
    expect(user.role).toBe('ADMIN');
  });

  it('filters by enum value', async () => {
    const tenant = await createTenant();
    await prisma.tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'u1', role: 'ADMIN' },
    });
    await prisma.tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'u2', role: 'MEMBER' },
    });
    await prisma.tenantUser.create({
      data: { tenantId: tenant.id, externalId: 'u3', role: 'MEMBER' },
    });
    const admins = await prisma.tenantUser.findMany({ where: { role: 'ADMIN' } });
    expect(admins).toHaveLength(1);
  });

  it('updates enum value (status transition)', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const job = await prisma.job.create({
      data: { friendlyId: 'job_1', workspaceId: ws.id },
    });
    expect(job.status).toBe('DRAFT');

    const updated = await prisma.job.update({
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
    const updated = await prisma.tenant.update({
      where: { id: tenant.id },
      data: { config: { theme: 'dark', notifications: { email: true, slack: false } } },
    });
    expect((updated.config as Record<string, unknown>).theme).toBe('dark');
  });

  it('stores explicit JsonB', async () => {
    const tenant = await createTenant();
    const updated = await prisma.tenant.update({
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
    const entry = await prisma.catalogEntry.create({
      data: { friendlyId: 'ce_1', name: 'test', pattern: '.*', provider: 'openai' },
    });
    const tier = await prisma.catalogTier.create({
      data: {
        name: 'Standard',
        isDefault: true,
        conditions: [{ region: 'us-east-1' }, { region: 'eu-west-1' }],
        entryId: entry.id,
      },
    });
    const fetched = await prisma.catalogTier.findUnique({ where: { id: tier.id } });
    expect(Array.isArray(fetched?.conditions)).toBe(true);
    expect((fetched?.conditions as unknown[])?.length).toBe(2);
  });
});

// ─── Decimal precision ───

describe('Decimal precision', () => {
  it('preserves Decimal(6,2) precision', async () => {
    const tenant = await createTenant();
    const ws = await prisma.workspace.create({
      data: {
        name: 'Precision WS',
        slug: 'precision',
        tenantId: tenant.id,
        apiKey: 'key_precision',
        rateLimit: '3.75',
      },
    });
    const fetched = await prisma.workspace.findUnique({ where: { id: ws.id } });
    expect(Number(fetched?.rateLimit)).toBeCloseTo(3.75, 2);
  });

  it('preserves Decimal(20,12) high precision', async () => {
    const entry = await prisma.catalogEntry.create({
      data: { friendlyId: 'ce_dec', name: 'gpt-4', pattern: '^gpt-4$', provider: 'openai' },
    });
    const tier = await prisma.catalogTier.create({
      data: { name: 'Default', isDefault: true, entryId: entry.id },
    });
    const price = await prisma.catalogPrice.create({
      data: { kind: 'input', amount: '0.000025000000', tierId: tier.id },
    });
    const fetched = await prisma.catalogPrice.findUnique({ where: { id: price.id } });
    expect(Number(fetched?.amount)).toBeCloseTo(0.000025, 12);
  });
});

// ─── String[] arrays ───

describe('String[] arrays', () => {
  it('stores and retrieves string arrays', async () => {
    const tenant = await createTenant();
    const updated = await prisma.tenant.update({
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
    await withPrismaAdapter({}, async (localPrisma) => {
      const tenant = await localPrisma.tenant.create({
        data: { name: 'Test Tenant', slug: 'test-tenant' },
      });
      const ws = await localPrisma.workspace.create({
        data: {
          name: 'Test WS',
          slug: 'test-ws',
          tenantId: tenant.id,
          apiKey: `key_${Date.now()}`,
        },
      });

      await localPrisma.job.createMany({
        data: [
          { friendlyId: 'j1', workspaceId: ws.id, tags: ['urgent', 'api'] },
          { friendlyId: 'j2', workspaceId: ws.id, tags: ['batch', 'api'] },
          { friendlyId: 'j3', workspaceId: ws.id, tags: ['batch'] },
        ],
      });

      const urgent = await localPrisma.job.findMany({ where: { tags: { has: 'urgent' } } });
      expect(urgent).toHaveLength(1);

      const api = await localPrisma.job.findMany({ where: { tags: { has: 'api' } } });
      expect(api).toHaveLength(2);
    });
  });
});

// ─── Bytes (binary data) ───

describe('Bytes (binary data)', () => {
  it('stores and retrieves binary data', async () => {
    const content = Buffer.from('Hello, binary world!');
    const blob = await prisma.blob.create({
      data: { name: 'test.txt', data: content, size: content.length },
    });
    const fetched = await prisma.blob.findUnique({ where: { id: blob.id } });
    expect(Buffer.from(fetched?.data as Buffer).toString()).toBe('Hello, binary world!');
  });

  it('handles large binary data', async () => {
    const content = Buffer.alloc(64 * 1024, 0xab);
    const blob = await prisma.blob.create({
      data: { name: 'large.bin', data: content, size: content.length },
    });
    const fetched = await prisma.blob.findUnique({ where: { id: blob.id } });
    expect((fetched?.data as Buffer).length).toBe(65536);
    expect(Buffer.from(fetched?.data as Buffer)[0]).toBe(0xab);
  });
});

// ─── Nested creates ───

describe('nested creates with relations', () => {
  it('creates parent with nested children', async () => {
    const entry = await prisma.catalogEntry.create({
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
    const job = await prisma.job.create({
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

    await prisma.dependency.create({
      data: { friendlyId: 'dep_1', type: 'manual', jobId: job.id },
    });

    const depCheck = await prisma.dependency.findMany({ where: { jobId: job.id } });
    expect(depCheck).toHaveLength(1);

    const withTwo = await prisma.job.findUnique({
      where: { id: job.id },
      include: { attempts: { orderBy: { number: 'asc' } }, workspace: true },
    });
    expect(withTwo?.attempts).toHaveLength(2);
    expect(withTwo?.attempts[0]?.number).toBe(1);

    const withDeep = await prisma.job.findUnique({
      where: { id: job.id },
      include: { workspace: { include: { tenant: true } } },
    });
    expect(withDeep?.workspace?.tenant?.slug).toBe('test-tenant');

    const deps = await prisma.dependency.findMany({ where: { jobId: job.id } });
    expect(deps).toHaveLength(1);
    expect(deps[0]?.type).toBe('manual');
  });
});

// ─── Upsert on composite unique ───

describe('upsert on composite unique', () => {
  it('creates on first call, updates on second', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    const created = await prisma.channel.upsert({
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

    const updated = await prisma.channel.upsert({
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
    const job = await prisma.job.create({
      data: {
        friendlyId: 'j_cascade',
        workspaceId: ws.id,
        attempts: { create: [{ number: 1 }, { number: 2 }] },
        snapshots: { create: { data: { checkpoint: true } } },
      },
    });

    await prisma.job.delete({ where: { id: job.id } });

    const attempts = await prisma.attempt.findMany({ where: { jobId: job.id } });
    const snapshots = await prisma.snapshot.findMany({ where: { jobId: job.id } });
    expect(attempts).toHaveLength(0);
    expect(snapshots).toHaveLength(0);
  });
});

// ─── Nullable field semantics ───

describe('nullable field semantics', () => {
  it('distinguishes null from undefined on update', async () => {
    const entry = await prisma.catalogEntry.create({
      data: {
        friendlyId: 'ce_null',
        name: 'test',
        pattern: '.*',
        provider: 'test',
        baseName: 'original-base',
      },
    });
    expect(entry.baseName).toBe('original-base');

    const cleared = await prisma.catalogEntry.update({
      where: { id: entry.id },
      data: { baseName: null },
    });
    expect(cleared.baseName).toBeNull();

    const fetched = await prisma.catalogEntry.findUnique({ where: { id: entry.id } });
    expect(fetched?.baseName).toBeNull();
  });

  it('omitting a field in update does not clear it', async () => {
    const entry = await prisma.catalogEntry.create({
      data: {
        friendlyId: 'ce_omit',
        name: 'test',
        pattern: '.*',
        provider: 'test',
        description: 'keep this',
      },
    });

    await prisma.catalogEntry.update({
      where: { id: entry.id },
      data: { name: 'updated' },
    });

    const fetched = await prisma.catalogEntry.findUnique({ where: { id: entry.id } });
    expect(fetched?.description).toBe('keep this');
  });
});

// ─── Batch operations ───

describe('batch operations', () => {
  it('createMany and count', async () => {
    await withPrismaAdapter({}, async (localPrisma) => {
      const tenant = await localPrisma.tenant.create({
        data: { name: 'Test Tenant', slug: 'test-tenant' },
      });
      const ws = await localPrisma.workspace.create({
        data: {
          name: 'Test WS',
          slug: 'test-ws',
          tenantId: tenant.id,
          apiKey: `key_${Date.now()}`,
        },
      });

      const { count } = await localPrisma.job.createMany({
        data: Array.from({ length: 50 }, (_, i) => ({
          friendlyId: `batch_${i}`,
          workspaceId: ws.id,
          priority: i % 5,
        })),
      });
      expect(count).toBe(50);

      const total = await localPrisma.job.count({ where: { workspaceId: ws.id } });
      expect(total).toBe(50);
    });
  });

  it('batch relation (jobs in a batch)', async () => {
    await withPrismaAdapter({}, async (localPrisma) => {
      const tenant = await localPrisma.tenant.create({
        data: { name: 'Test Tenant', slug: 'test-tenant' },
      });
      const ws = await localPrisma.workspace.create({
        data: {
          name: 'Test WS',
          slug: 'test-ws',
          tenantId: tenant.id,
          apiKey: `key_${Date.now()}`,
        },
      });
      const batch = await localPrisma.batch.create({
        data: { friendlyId: 'batch_1' },
      });

      await localPrisma.job.createMany({
        data: [
          { friendlyId: 'bj_1', workspaceId: ws.id, batchId: batch.id },
          { friendlyId: 'bj_2', workspaceId: ws.id, batchId: batch.id },
        ],
      });

      const found = await localPrisma.batch.findUnique({
        where: { id: batch.id },
        include: { jobs: true },
      });
      expect(found?.jobs).toHaveLength(2);
    });
  });
});

// ─── Timestamps ───

describe('updatedAt auto-generation', () => {
  it('sets updatedAt on create and update', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const job = await prisma.job.create({
      data: { friendlyId: 'j_ts', workspaceId: ws.id },
    });
    const createdUpdatedAt = job.updatedAt;
    expect(createdUpdatedAt).toBeInstanceOf(Date);

    await new Promise((r) => setTimeout(r, 50));

    const updated = await prisma.job.update({
      where: { id: job.id },
      data: { status: 'ACTIVE' },
    });
    expect(updated.updatedAt.getTime()).toBeGreaterThan(createdUpdatedAt.getTime());
  });
});

// ─── Transactions ───

describe('transactions', () => {
  it('commits on success', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    await prisma.$transaction(async (tx) => {
      await tx.job.create({ data: { friendlyId: 'tx_1', workspaceId: ws.id } });
      await tx.job.create({ data: { friendlyId: 'tx_2', workspaceId: ws.id } });
    });

    const count = await prisma.job.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(2);
  });

  it('commits with SERIALIZABLE isolation level', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    await prisma.$transaction(
      async (tx) => {
        await tx.job.create({ data: { friendlyId: 'iso_1', workspaceId: ws.id } });
        await tx.job.create({ data: { friendlyId: 'iso_2', workspaceId: ws.id } });
      },
      { isolationLevel: 'Serializable' },
    );

    const count = await prisma.job.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(2);
  });

  it('rolls back on error', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    await expect(
      prisma.$transaction(async (tx) => {
        await tx.job.create({ data: { friendlyId: 'tx_fail_1', workspaceId: ws.id } });
        await tx.job.create({ data: { friendlyId: 'tx_fail_1', workspaceId: ws.id } });
      }),
    ).rejects.toThrow();

    const count = await prisma.job.count({ where: { workspaceId: ws.id } });
    expect(count).toBe(0);
  });
});

// ─── Ordering ───

describe('ordering and sorted indexes', () => {
  it('orders by descending createdAt using sorted index', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    for (let i = 0; i < 5; i++) {
      await prisma.job.create({
        data: { friendlyId: `ord_${i}`, workspaceId: ws.id, priority: i },
      });
      await new Promise((r) => setTimeout(r, 10));
    }

    const jobs = await prisma.job.findMany({
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

    const channel = await prisma.channel.create({
      data: { friendlyId: 'ch_m2m', name: 'events', workspaceId: ws.id },
    });

    await prisma.item.create({
      data: {
        key: 'item-1',
        value: { data: 'hello' },
        workspaceId: ws.id,
        channels: { connect: { id: channel.id } },
      },
    });
    await prisma.item.create({
      data: {
        key: 'item-2',
        value: { data: 'world' },
        workspaceId: ws.id,
        channels: { connect: { id: channel.id } },
      },
    });

    const found = await prisma.channel.findUnique({
      where: { id: channel.id },
      include: { items: true },
    });
    expect(found?.items).toHaveLength(2);
  });
});

// ─── Snapshot / Restore ───

describe('snapshotDb', () => {
  // Tests in this block are stateful-sequential — order matters
  let prisma: PrismaClient;
  let resetDb: ResetDbFn;
  let snapshotDb: SnapshotDbFn;
  let resetSnapshot: ResetSnapshotFn;
  let closeSnapshotAdapter: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    let adapter: PgliteAdapter['adapter'];
    ({
      adapter,
      resetDb,
      snapshotDb,
      resetSnapshot,
      close: closeSnapshotAdapter,
    } = await createPgliteAdapter());
    prisma = new PrismaClient({ adapter });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await closeSnapshotAdapter?.();
  });

  it('restores seeded data after resetDb', async () => {
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
    await resetDb();

    const newTenant = await prisma.tenant.create({
      data: { name: 'New Tenant', slug: 'new-tenant' },
    });
    expect(newTenant.id).toBeDefined();
    expect(await prisma.tenant.count()).toBe(2);
  });

  it('overwrites previous snapshot', async () => {
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
    await resetSnapshot();
    await resetDb();

    expect(await prisma.tenant.count()).toBe(0);
  });

  it('restores rows from non-public schemas', async () => {
    const { pglite, snapshotDb, resetDb, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE baseline (id int PRIMARY KEY)',
    });

    try {
      await pglite.exec('CREATE SCHEMA extra');
      await pglite.exec(
        'CREATE TABLE extra.snapshot_test (id int PRIMARY KEY, name text NOT NULL)',
      );
      await pglite.exec("INSERT INTO extra.snapshot_test VALUES (1, 'seed')");

      await snapshotDb();

      await pglite.exec(
        "DELETE FROM extra.snapshot_test; INSERT INTO extra.snapshot_test VALUES (2, 'changed')",
      );
      await resetDb();

      const { rows } = await pglite.query<{ id: number; name: string }>(
        'SELECT id, name FROM extra.snapshot_test ORDER BY id',
      );
      expect(rows).toEqual([{ id: 1, name: 'seed' }]);
    } finally {
      await close();
    }
  });

  it('supports quoted identifiers containing single quotes', async () => {
    const { pglite, snapshotDb, resetDb, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE baseline (id int PRIMARY KEY)',
    });

    try {
      await pglite.exec('CREATE SCHEMA "s\'q"');
      await pglite.exec('CREATE TABLE "s\'q"."t\'q" (id int PRIMARY KEY, name text NOT NULL)');
      await pglite.exec('INSERT INTO "s\'q"."t\'q" VALUES (1, \'seed\')');

      await snapshotDb();

      await pglite.exec('DELETE FROM "s\'q"."t\'q"');
      await resetDb();

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
  it('preserves and restores sequence positions', async () => {
    const {
      adapter: seqAdapter,
      resetDb: seqResetDb,
      snapshotDb: seqSnapshotDb,
      close,
    } = await createPgliteAdapter({
      sql: 'CREATE TABLE counter (id serial PRIMARY KEY, label text NOT NULL)',
    });
    const seqPrisma = new PrismaClient({ adapter: seqAdapter });
    try {
      await seqPrisma.$queryRawUnsafe("INSERT INTO counter (label) VALUES ('a'), ('b'), ('c')");

      await seqSnapshotDb();
      await seqResetDb();

      const rows = await seqPrisma.$queryRawUnsafe<{ id: number; label: string }[]>(
        'SELECT * FROM counter ORDER BY id',
      );
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.label)).toEqual(['a', 'b', 'c']);

      await seqPrisma.$queryRawUnsafe("INSERT INTO counter (label) VALUES ('d')");
      const next = await seqPrisma.$queryRawUnsafe<{ id: number }[]>(
        "SELECT id FROM counter WHERE label = 'd'",
      );
      expect(next[0]?.id).toBe(4);
    } finally {
      await seqPrisma.$disconnect();
      await close();
    }
  });

  it('restores unused sequences to their initial position', async () => {
    const {
      pglite,
      resetDb: seqResetDb,
      snapshotDb: seqSnapshotDb,
      close,
    } = await createPgliteAdapter({
      sql: 'CREATE TABLE counter_unused (id serial PRIMARY KEY, label text NOT NULL)',
    });

    try {
      await seqSnapshotDb();
      await pglite.exec("INSERT INTO counter_unused (label) VALUES ('after-snapshot')");
      await seqResetDb();
      await pglite.exec("INSERT INTO counter_unused (label) VALUES ('after-reset')");

      const { rows } = await pglite.query<{ id: number; label: string }>(
        'SELECT id, label FROM counter_unused ORDER BY id',
      );
      expect(rows).toEqual([{ id: 1, label: 'after-reset' }]);
    } finally {
      await close();
    }
  });
});

describe('backwards compat: resetDb without snapshot still truncates', () => {
  it('truncates to empty when no snapshot exists', async () => {
    await prisma.tenant.create({
      data: { name: 'Compat Tenant', slug: 'compat' },
    });
    expect(await prisma.tenant.count()).toBe(1);

    await resetDb();

    expect(await prisma.tenant.count()).toBe(0);
  });

  it('resetDb restarts serial sequences even without a snapshot', async () => {
    const { pglite, resetDb, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE counter (id serial PRIMARY KEY, label text NOT NULL)',
    });

    try {
      await pglite.exec("INSERT INTO counter (label) VALUES ('before-reset')");
      await resetDb();
      await pglite.exec("INSERT INTO counter (label) VALUES ('after-reset')");

      const { rows } = await pglite.query<{ id: number }>(
        "SELECT id FROM counter WHERE label = 'after-reset'",
      );
      expect(rows[0]?.id).toBe(1);
    } finally {
      await close();
    }
  });
});

// ─── Sentinel initialization detection ───

describe('sentinel initialization detection', () => {
  const SENTINEL_SCHEMA = '_pglite_bridge';
  const SENTINEL_TABLE = '__initialized';
  const SENTINEL_MARKER = 'prisma-pglite-bridge:init:v1';

  const querySentinel = async (pglite: PGlite) => {
    const { rows } = await pglite.query<{ marker: string; version: number }>(
      `SELECT marker, version FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" LIMIT 1`,
    );
    return rows[0];
  };

  it('backfills sentinel on pre-sentinel legacy dataDir', async () => {
    await withTempDataDir(async (dataDir) => {
      // Simulate a pre-sentinel database: create objects directly via PGlite
      const raw = new PGlite(dataDir);
      await raw.exec('CREATE TABLE legacy_table (id int PRIMARY KEY)');
      await raw.exec('INSERT INTO legacy_table VALUES (1)');
      await raw.close();

      // Reopen via adapter — legacy fallback should detect and backfill
      await withAdapter(
        {
          dataDir,
          sql: 'CREATE TABLE legacy_table (id int PRIMARY KEY)',
        },
        async (adapter) => {
          const { rows } = await adapter.pglite.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM legacy_table',
          );
          expect(rows[0]?.n).toBe(1);

          const sentinel = await querySentinel(adapter.pglite);
          expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
        },
      );
    });
  });

  it('backfills sentinel on pre-sentinel legacy dataDir with only enums', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec("CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')");
      await raw.close();

      await withAdapter(
        {
          dataDir,
          sql: "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
        },
        async (adapter) => {
          const { rows } = await adapter.pglite.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_type WHERE typname = 'mood'",
          );
          expect(rows[0]?.n).toBe(1);

          const sentinel = await querySentinel(adapter.pglite);
          expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
        },
      );
    });
  });

  it('backfills sentinel on pre-sentinel legacy dataDir with only sequences', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec('CREATE SEQUENCE custom_seq START 5');
      await raw.close();

      await withAdapter(
        {
          dataDir,
          sql: 'CREATE SEQUENCE custom_seq START 5',
        },
        async (adapter) => {
          const { rows } = await adapter.pglite.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname = 'custom_seq'",
          );
          expect(rows[0]?.n).toBe(1);

          const sentinel = await querySentinel(adapter.pglite);
          expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
        },
      );
    });
  });

  it('backfills sentinel on pre-sentinel legacy dataDir with only functions', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec(
        'CREATE FUNCTION add_one(x int) RETURNS int AS $$ SELECT x + 1 $$ LANGUAGE sql',
      );
      await raw.close();

      await withAdapter(
        {
          dataDir,
          sql: 'CREATE FUNCTION add_one(x int) RETURNS int AS $$ SELECT x + 1 $$ LANGUAGE sql',
        },
        async (adapter) => {
          const { rows } = await adapter.pglite.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'add_one'",
          );
          expect(rows[0]?.n).toBe(1);

          const sentinel = await querySentinel(adapter.pglite);
          expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
        },
      );
    });
  });

  it('backfills sentinel on pre-sentinel legacy dataDir with only non-public schema', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec('CREATE SCHEMA extra; CREATE TABLE extra.persisted (id int PRIMARY KEY)');
      await raw.close();

      await withAdapter(
        {
          dataDir,
          sql: 'CREATE SCHEMA extra; CREATE TABLE extra.persisted (id int PRIMARY KEY)',
        },
        async (adapter) => {
          const { rows } = await adapter.pglite.query<{ n: number }>(
            'SELECT count(*)::int AS n FROM extra.persisted',
          );
          expect(rows[0]?.n).toBe(0);

          const sentinel = await querySentinel(adapter.pglite);
          expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
        },
      );
    });
  });

  it('throws collision error on reopen when only reserved schema exists', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec(`CREATE SCHEMA "${SENTINEL_SCHEMA}"`);
      await raw.close();

      await expect(createPgliteAdapter({ dataDir, sql: 'SELECT 1' })).rejects.toThrow(
        `Schema "${SENTINEL_SCHEMA}" exists but is not owned by prisma-pglite-bridge`,
      );
    });
  });

  it('adopts reserved schema on first-run explicit sql', async () => {
    const sql = `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"; CREATE TABLE test_adopt (id int PRIMARY KEY)`;
    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async (adapter) => {
        const sentinel = await querySentinel(adapter.pglite);
        expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
      });

      // Reopen should work via sentinel
      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM test_adopt',
        );
        expect(rows[0]?.n).toBe(0);
      });
    });
  });

  it('restores absent sentinel via legacy fallback', async () => {
    const sql = 'CREATE TABLE recovery_test (id int PRIMARY KEY)';
    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async (first) => {
        // Sentinel should exist after first run
        const sentinel = await querySentinel(first.pglite);
        expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });

        // Simulate crash between user SQL and sentinel write: drop sentinel schema
        await first.pglite.exec(`DROP SCHEMA "${SENTINEL_SCHEMA}" CASCADE`);
      });

      // Reopen — legacy fallback should restore sentinel
      await withAdapter({ dataDir, sql }, async (second) => {
        const restored = await querySentinel(second.pglite);
        expect(restored).toEqual({ marker: SENTINEL_MARKER, version: 1 });
      });
    });
  });

  it('succeeds when user SQL creates exact sentinel (idempotent writeSentinel)', async () => {
    const sql = [
      `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
      `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 1)`,
      'CREATE TABLE user_data (id int PRIMARY KEY)',
    ].join(';\n');

    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async (first) => {
        const sentinel = await querySentinel(first.pglite);
        expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
      });

      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM user_data',
        );
        expect(rows[0]?.n).toBe(0);
      });
    });
  });

  it('throws collision error on reopen when sentinel has wrong version', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec(`CREATE SCHEMA "${SENTINEL_SCHEMA}"`);
      await raw.exec(
        `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      );
      await raw.exec(
        `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 99)`,
      );
      await raw.close();

      await expect(createPgliteAdapter({ dataDir, sql: 'SELECT 1' })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );
    });
  });

  it('throws collision error on first-run explicit sql when sentinel has wrong version', async () => {
    const sql = [
      `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
      `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 99)`,
      'CREATE TABLE user_data (id int PRIMARY KEY)',
    ].join(';\n');

    await withTempDataDir(async (dataDir) => {
      await expect(createPgliteAdapter({ dataDir, sql })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );
    });
  });

  it('throws collision error on reopen when sentinel table has wrong columns', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec(`CREATE SCHEMA "${SENTINEL_SCHEMA}"`);
      await raw.exec(`CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (id int PRIMARY KEY)`);
      await raw.close();

      await expect(createPgliteAdapter({ dataDir, sql: 'SELECT 1' })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );
    });
  });

  it('throws collision error on first-run explicit sql when sentinel table has wrong columns', async () => {
    const sql = [
      `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
      `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (id int PRIMARY KEY)`,
      'CREATE TABLE user_data (id int PRIMARY KEY)',
    ].join(';\n');

    await withTempDataDir(async (dataDir) => {
      await expect(createPgliteAdapter({ dataDir, sql })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );
    });
  });

  it('throws collision error on first-run migration path when sentinel has wrong version', async () => {
    await withTempDataDir(async (dataDir) => {
      const migrationsPath = mkdtempSync(join(tmpdir(), 'migrations-'));
      const migrationDir = join(migrationsPath, '0001_init');
      mkdirSync(migrationDir);
      writeFileSync(
        join(migrationDir, 'migration.sql'),
        [
          `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
          `CREATE TABLE IF NOT EXISTS "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
          `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 99)`,
          'CREATE TABLE user_data (id int PRIMARY KEY)',
        ].join(';\n'),
      );

      try {
        await expect(createPgliteAdapter({ dataDir, migrationsPath })).rejects.toThrow(
          'exists but is not owned by prisma-pglite-bridge',
        );

        // Verify the transaction was rolled back — dataDir should be clean
        const raw = new PGlite(dataDir);
        const { rows } = await raw.query<{ found: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'user_data') AS found`,
        );
        expect(rows[0]?.found).toBe(false);
        await raw.close();
      } finally {
        rmSync(migrationsPath, { recursive: true, force: true });
      }
    });
  });

  it('throws collision error when sentinel table has extra non-library rows', async () => {
    const sql = [
      `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
      `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('user-owned', 99)`,
      'CREATE TABLE user_data (id int PRIMARY KEY)',
    ].join(';\n');

    await withTempDataDir(async (dataDir) => {
      await expect(createPgliteAdapter({ dataDir, sql })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );

      // Verify writeSentinel rolled back — no library marker persisted
      const raw = new PGlite(dataDir);
      const { rows } = await raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" WHERE marker = '${SENTINEL_MARKER}'`,
      );
      expect(rows[0]?.n).toBe(0);
      await raw.close();
    });
  });

  it('throws collision error on reopen when sentinel table has extra non-library rows', async () => {
    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec(`CREATE SCHEMA "${SENTINEL_SCHEMA}"`);
      await raw.exec(
        `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      );
      await raw.exec(
        `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 1)`,
      );
      await raw.exec(
        `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('user-owned', 99)`,
      );
      await raw.close();

      await expect(createPgliteAdapter({ dataDir, sql: 'SELECT 1' })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );
    });
  });
});

// ─── Stats collection ───

describe('stats collection', () => {
  it('level 0: stats() returns null and feature is off', async () => {
    const { stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
    });
    try {
      expect(await stats()).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('level 0 by default (no statsLevel option)', async () => {
    const { stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
    });
    try {
      expect(await stats()).toBeUndefined();
    } finally {
      await close();
    }
  });

  it('rejects out-of-range statsLevel at runtime', async () => {
    await expect(
      createPgliteAdapter({
        sql: 'CREATE TABLE s (id int PRIMARY KEY)',
        statsLevel: -1 as unknown as StatsLevel,
      }),
    ).rejects.toThrow(/statsLevel must be 0, 1, or 2/);
    await expect(
      createPgliteAdapter({
        sql: 'CREATE TABLE s (id int PRIMARY KEY)',
        statsLevel: 3 as unknown as StatsLevel,
      }),
    ).rejects.toThrow(/statsLevel must be 0, 1, or 2/);
  });

  it('level 1: counters reflect Prisma round-trips', async () => {
    const { adapter, stats, resetDb, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE stat_tbl (id serial PRIMARY KEY, name text NOT NULL)',
      statsLevel: 1,
    });
    const prismaClient = new PrismaClient({ adapter });
    try {
      await prismaClient.$executeRawUnsafe("INSERT INTO stat_tbl (name) VALUES ('a')");
      await prismaClient.$executeRawUnsafe("INSERT INTO stat_tbl (name) VALUES ('b')");
      await prismaClient.$queryRawUnsafe('SELECT * FROM stat_tbl');
      await resetDb();

      const s = await stats();
      if (s === undefined) throw new Error('stats() returned undefined');
      expect(s.statsLevel).toBe(1);
      expect(s.queryCount).toBeGreaterThan(0);
      expect(s.failedQueryCount).toBe(0);
      expect(s.resetDbCalls).toBe(1);
      expect(s.durationMs).toBeGreaterThan(0);
      expect(s.avgQueryMs).toBeGreaterThan(0);
      expect(s.dbSizeBytes).toBeGreaterThan(0);
      expect(s.wasmInitMs).toBeGreaterThan(0);
      expect(s.schemaSetupMs).toBeGreaterThan(0);
    } finally {
      await prismaClient.$disconnect();
      await close();
    }
  });

  it('level 1 N=0 boundary: stats before any query', async () => {
    const { stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });
    try {
      const s = await stats();
      if (s === undefined) throw new Error('stats() returned undefined');
      expect(s.statsLevel).toBe(1);
      expect(s.queryCount).toBe(0);
      expect(s.failedQueryCount).toBe(0);
      expect(s.totalQueryMs).toBe(0);
      expect(s.avgQueryMs).toBe(0);
      expect(s.recentP50QueryMs).toBe(0);
      expect(s.recentP95QueryMs).toBe(0);
      expect(s.recentMaxQueryMs).toBe(0);
      expect(s.resetDbCalls).toBe(0);
      expect(s.durationMs).toBeGreaterThan(0);
      expect(s.dbSizeBytes).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it('level 1 failed-query path: failure appears in stats', async () => {
    const { adapter, stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });
    const prismaClient = new PrismaClient({ adapter });
    try {
      await expect(
        prismaClient.$queryRawUnsafe('SELECT * FROM nonexistent_table_xyz'),
      ).rejects.toThrow();

      const s = await stats();
      if (s === undefined) throw new Error('stats() returned undefined');
      expect(s.queryCount).toBeGreaterThan(0);
      expect(s.failedQueryCount).toBeGreaterThan(0);
      expect(s.totalQueryMs).toBeGreaterThan(0);
    } finally {
      await prismaClient.$disconnect();
      await close();
    }
  });

  it('level 2: processPeakRssBytes and session-lock fields all defined', async () => {
    const { adapter, stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 2,
    });
    const prismaClient = new PrismaClient({ adapter });
    try {
      await prismaClient.$executeRawUnsafe('INSERT INTO s (id) VALUES (1)');

      const s = await stats();
      if (s === undefined) throw new Error('stats() returned undefined');
      if (s.statsLevel !== 2) throw new Error('expected level 2');
      expect(typeof s.processRssPeakBytes).toBe('number');
      expect(s.processRssPeakBytes).toBeGreaterThan(0);
      expect(typeof s.totalSessionLockWaitMs).toBe('number');
      expect(typeof s.sessionLockAcquisitionCount).toBe('number');
      expect(typeof s.avgSessionLockWaitMs).toBe('number');
      expect(typeof s.maxSessionLockWaitMs).toBe('number');
      expect(s.sessionLockAcquisitionCount).toBeGreaterThan(0);
    } finally {
      await prismaClient.$disconnect();
      await close();
    }
  });

  it('level 1 post-close idempotence: durationMs frozen, counters stable, cached dbSize', async () => {
    const { adapter, stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });
    const prismaClient = new PrismaClient({ adapter });

    await prismaClient.$executeRawUnsafe('INSERT INTO s (id) VALUES (1)');
    const preClose = await stats();
    if (preClose === undefined) throw new Error('pre-close stats null');

    await prismaClient.$disconnect();
    await close();

    const post1 = await stats();
    const post2 = await stats();
    if (post1 === undefined || post2 === undefined) throw new Error('post-close stats null');

    expect(post1.durationMs).toBeGreaterThanOrEqual(preClose.durationMs);
    expect(post2.durationMs).toBe(post1.durationMs);
    expect(post1.dbSizeBytes).toBe(post2.dbSizeBytes);
    expect(post1.queryCount).toBe(post2.queryCount);
    expect(post1.queryCount).toBeGreaterThanOrEqual(preClose.queryCount);
  });

  it('level 1 close-race cache boundary: post-close stats do not touch pglite', async () => {
    const { pglite, stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });

    const querySpy = vi.spyOn(pglite, 'query');
    await close();
    const callsAfterClose = querySpy.mock.calls.length;

    await stats();
    await stats();
    expect(querySpy.mock.calls.length).toBe(callsAfterClose);

    querySpy.mockRestore();
  });

  it('level 2 short-run processPeakRssBytes: bookend samples only', async () => {
    const memSpy = vi.spyOn(process, 'memoryUsage');
    try {
      const { stats, close } = await createPgliteAdapter({
        sql: 'CREATE TABLE s (id int PRIMARY KEY)',
        statsLevel: 2,
      });
      const baseline = memSpy.mock.calls.length;
      await close();
      const s = await stats();
      if (s === undefined) throw new Error('stats() returned undefined');
      if (s.statsLevel !== 2) throw new Error('expected level 2');

      expect(memSpy.mock.calls.length - baseline).toBe(1);
      expect(typeof s.processRssPeakBytes).toBe('number');
      expect(s.processRssPeakBytes).toBeGreaterThan(0);
    } finally {
      memSpy.mockRestore();
    }
  });

  it('close() is re-entrant: concurrent calls return the same promise', async () => {
    const { close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });

    const [a, b, c] = await Promise.all([close(), close(), close()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await expect(close()).resolves.toBeUndefined();
  });

  it('level 1 concurrent stats() during close(): both resolve without throwing', async () => {
    const { adapter, stats, close } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });
    const prismaClient = new PrismaClient({ adapter });
    await prismaClient.$executeRawUnsafe('INSERT INTO s (id) VALUES (1)');
    await prismaClient.$disconnect();

    const closePromise = close();
    const statsPromise = stats();
    const [, snap] = await Promise.all([closePromise, statsPromise]);

    if (snap === undefined) throw new Error('concurrent stats null');
    expect(snap.statsLevel).toBe(1);
    expect(snap.durationMs).toBeGreaterThan(0);
    expect(snap.queryCount).toBeGreaterThan(0);
  });

  it('level 1 simple-query path: direct pool query increments queryCount', async () => {
    const {
      adapter: _adapter,
      stats,
      pglite: _pglite,
      close,
    } = await createPgliteAdapter({
      sql: 'CREATE TABLE s (id int PRIMARY KEY)',
      statsLevel: 1,
    });
    void _adapter;
    void _pglite;
    try {
      const before = await stats();
      if (before === undefined) throw new Error('stats null');

      const prismaClient = new PrismaClient({ adapter: _adapter });
      await prismaClient.$executeRawUnsafe('SELECT 1');
      await prismaClient.$disconnect();

      const after = await stats();
      if (after === undefined) throw new Error('stats null');
      expect(after.queryCount).toBeGreaterThan(before.queryCount);
      expect(after.totalQueryMs).toBeGreaterThan(before.totalQueryMs);
    } finally {
      await close();
    }
  });
});
