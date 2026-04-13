import { PrismaClient } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  PgliteAdapter,
  ResetDbFn,
  ResetSnapshotFn,
  SnapshotDbFn,
} from './create-pglite-adapter.ts';
import { createPgliteAdapter } from './create-pglite-adapter.ts';

let prisma: PrismaClient;
let resetDb: ResetDbFn;

beforeAll(async () => {
  let adapter: PgliteAdapter['adapter'];
  ({ adapter, resetDb } = await createPgliteAdapter());
  prisma = new PrismaClient({ adapter });
});

beforeEach(() => resetDb());

// ─── Helpers ───

const createTenant = (slug = 'test-tenant') =>
  prisma.tenant.create({ data: { name: 'Test Tenant', slug } });

const createWorkspace = (tenantId: string, slug = 'test-ws') =>
  prisma.workspace.create({
    data: { name: 'Test WS', slug, tenantId, apiKey: `key_${slug}_${Date.now()}` },
  });

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
    await prisma.tenantUser.createMany({
      data: [
        { tenantId: tenant.id, externalId: 'u1', role: 'ADMIN' },
        { tenantId: tenant.id, externalId: 'u2', role: 'MEMBER' },
        { tenantId: tenant.id, externalId: 'u3', role: 'MEMBER' },
      ],
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
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    await prisma.job.createMany({
      data: [
        { friendlyId: 'j1', workspaceId: ws.id, tags: ['urgent', 'api'] },
        { friendlyId: 'j2', workspaceId: ws.id, tags: ['batch', 'api'] },
        { friendlyId: 'j3', workspaceId: ws.id, tags: ['batch'] },
      ],
    });
    const urgent = await prisma.job.findMany({ where: { tags: { has: 'urgent' } } });
    expect(urgent).toHaveLength(1);

    const api = await prisma.job.findMany({ where: { tags: { has: 'api' } } });
    expect(api).toHaveLength(2);
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
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);

    const { count } = await prisma.job.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        friendlyId: `batch_${i}`,
        workspaceId: ws.id,
        priority: i % 5,
      })),
    });
    expect(count).toBe(50);

    const total = await prisma.job.count({ where: { workspaceId: ws.id } });
    expect(total).toBe(50);
  });

  it('batch relation (jobs in a batch)', async () => {
    const tenant = await createTenant();
    const ws = await createWorkspace(tenant.id);
    const batch = await prisma.batch.create({
      data: { friendlyId: 'batch_1' },
    });

    await prisma.job.createMany({
      data: [
        { friendlyId: 'bj_1', workspaceId: ws.id, batchId: batch.id },
        { friendlyId: 'bj_2', workspaceId: ws.id, batchId: batch.id },
      ],
    });

    const found = await prisma.batch.findUnique({
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
  let prisma: PrismaClient;
  let resetDb: ResetDbFn;
  let snapshotDb: SnapshotDbFn;
  let resetSnapshot: ResetSnapshotFn;

  beforeAll(async () => {
    let adapter: PgliteAdapter['adapter'];
    ({ adapter, resetDb, snapshotDb, resetSnapshot } = await createPgliteAdapter());
    prisma = new PrismaClient({ adapter });
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
});

describe('snapshot with auto-increment sequences', () => {
  it('preserves and restores sequence positions', async () => {
    const {
      adapter: seqAdapter,
      resetDb: seqResetDb,
      snapshotDb: seqSnapshotDb,
    } = await createPgliteAdapter({
      sql: 'CREATE TABLE counter (id serial PRIMARY KEY, label text NOT NULL)',
    });
    const seqPrisma = new PrismaClient({ adapter: seqAdapter });

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
});
