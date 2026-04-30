import type { PrismaClient } from '@prisma/client';

export const seed = async (prisma: PrismaClient): Promise<void> => {
  const acme = await prisma.tenant.create({
    data: {
      id: 'tenant-acme',
      name: 'Acme Inc.',
      slug: 'acme',
      config: { plan: 'enterprise', region: 'us-east' },
      flags: { betaUi: true, exportsV2: false },
      labels: ['priority', 'paid'],
      users: {
        create: [
          { id: 'tu-acme-alice', role: 'ADMIN', externalId: 'alice@acme.test' },
          { id: 'tu-acme-bob', role: 'MEMBER', externalId: 'bob@acme.test' },
        ],
      },
      workspaces: {
        create: [
          {
            id: 'ws-acme-prod',
            name: 'Acme Prod',
            slug: 'prod',
            apiKey: 'key-acme-prod',
            rateLimit: '12.50',
            tags: ['prod', 'critical'],
            settings: { timezone: 'UTC', dryRun: false },
          },
          {
            id: 'ws-acme-staging',
            name: 'Acme Staging',
            slug: 'staging',
            apiKey: 'key-acme-staging',
            rateLimit: '5.00',
            tags: ['staging'],
            settings: { timezone: 'UTC', dryRun: true },
          },
        ],
      },
    },
  });

  await prisma.tenant.create({
    data: {
      id: 'tenant-globex',
      name: 'Globex Corp.',
      slug: 'globex',
      config: { plan: 'starter' },
      labels: ['trial'],
      users: {
        create: [{ id: 'tu-globex-eve', role: 'VIEWER', externalId: 'eve@globex.test' }],
      },
      workspaces: {
        create: [
          {
            id: 'ws-globex-main',
            name: 'Globex Main',
            slug: 'main',
            apiKey: 'key-globex-main',
            tags: ['default'],
          },
        ],
      },
    },
  });

  await prisma.channel.createMany({
    data: [
      { id: 'ch-prod-fast', friendlyId: 'CH-001', name: 'fast', workspaceId: 'ws-acme-prod' },
      {
        id: 'ch-prod-slow',
        friendlyId: 'CH-002',
        name: 'slow',
        type: 'LIFO',
        workspaceId: 'ws-acme-prod',
      },
      {
        id: 'ch-globex-default',
        friendlyId: 'CH-003',
        name: 'default',
        workspaceId: 'ws-globex-main',
      },
    ],
  });

  await prisma.item.create({
    data: {
      id: 'item-prod-foo',
      key: 'foo',
      value: { kind: 'config', enabled: true },
      workspaceId: 'ws-acme-prod',
      channels: { connect: [{ id: 'ch-prod-fast' }] },
    },
  });
  await prisma.item.create({
    data: {
      id: 'item-prod-bar',
      key: 'bar',
      value: { kind: 'config', enabled: false },
      version: 2,
      workspaceId: 'ws-acme-prod',
      channels: { connect: [{ id: 'ch-prod-fast' }, { id: 'ch-prod-slow' }] },
    },
  });

  await prisma.catalogEntry.create({
    data: {
      id: 'cat-pro',
      friendlyId: 'PRO',
      name: 'Pro',
      pattern: 'pro-*',
      provider: 'stripe',
      capabilities: ['billing', 'reports'],
      tiers: {
        create: [
          {
            id: 'tier-pro-default',
            name: 'default',
            isDefault: true,
            conditions: [{ kind: 'always' }],
            prices: {
              create: [
                { id: 'price-pro-monthly', kind: 'monthly', amount: '49.999999999999' },
                { id: 'price-pro-yearly', kind: 'yearly', amount: '499.000000000001' },
              ],
            },
          },
        ],
      },
    },
  });

  const batch = await prisma.batch.create({
    data: {
      id: 'batch-1',
      friendlyId: 'B-001',
      status: 'ACTIVE',
      metadata: { kicker: 'manual' },
    },
  });

  await prisma.job.create({
    data: {
      id: 'job-active',
      friendlyId: 'J-001',
      status: 'ACTIVE',
      priority: 5,
      payload: { input: { a: 1, b: 2 } },
      tags: ['urgent', 'audit'],
      workspaceId: 'ws-acme-prod',
      batchId: batch.id,
      attempts: {
        create: [
          {
            id: 'att-1-1',
            number: 1,
            status: 'ARCHIVED',
            output: { stdout: 'first run' },
            completedAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'att-1-2',
            number: 2,
            status: 'ACTIVE',
          },
        ],
      },
      dependencies: {
        create: [
          {
            id: 'dep-1',
            friendlyId: 'D-001',
            type: 'blocker',
            status: 'ACTIVE',
          },
        ],
      },
      snapshots: {
        create: [
          {
            id: 'snap-1',
            data: { state: 'pre-run', sequence: 0 },
          },
        ],
      },
    },
  });

  await prisma.job.create({
    data: {
      id: 'job-draft',
      friendlyId: 'J-002',
      status: 'DRAFT',
      payload: { input: 'pending' },
      workspaceId: 'ws-acme-staging',
    },
  });

  await prisma.blob.create({
    data: {
      id: 'blob-1',
      name: 'logo.bin',
      data: Buffer.from('seed-bytes'),
      contentType: 'application/octet-stream',
      size: 'seed-bytes'.length,
    },
  });

  void acme;
};
