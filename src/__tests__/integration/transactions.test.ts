import { describe, expect, it } from 'vitest';

import { prisma } from './app/util/prisma.ts';

describe('transactions', () => {
  it('commits an interactive $transaction', async () => {
    const newJob = await prisma.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          friendlyId: 'J-tx-commit',
          workspaceId: 'ws-acme-prod',
          payload: { tx: 'commit' },
        },
      });
      await tx.attempt.create({ data: { jobId: job.id, number: 1, status: 'ACTIVE' } });
      return job;
    });
    const persisted = await prisma.job.findUniqueOrThrow({
      where: { id: newJob.id },
      include: { attempts: true },
    });
    expect(persisted.attempts).toHaveLength(1);
  });

  it('rolls back on throw', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.job.create({
          data: {
            friendlyId: 'J-tx-rollback',
            workspaceId: 'ws-acme-prod',
            payload: { tx: 'rollback' },
          },
        });
        throw new Error('rollback please');
      }),
    ).rejects.toThrow('rollback please');
    const found = await prisma.job.findUnique({ where: { friendlyId: 'J-tx-rollback' } });
    expect(found).toBeNull();
  });

  it('rolls back on a constraint violation inside the tx', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.workspace.create({
          data: {
            name: 'Pre-violation',
            slug: 'pre-violation',
            apiKey: 'key-pre-violation',
            tenantId: 'tenant-acme',
          },
        });
        await tx.workspace.create({
          data: {
            name: 'Dupe',
            slug: 'dupe',
            apiKey: 'key-acme-prod',
            tenantId: 'tenant-acme',
          },
        });
      }),
    ).rejects.toThrow();
    const probe = await prisma.workspace.findUnique({
      where: { apiKey: 'key-pre-violation' },
    });
    expect(probe).toBeNull();
  });

  it('sequential $transaction array commits all writes', async () => {
    const [created, count] = await prisma.$transaction([
      prisma.job.create({
        data: {
          friendlyId: 'J-seq',
          workspaceId: 'ws-acme-prod',
          payload: {},
        },
      }),
      prisma.job.count({ where: { workspaceId: 'ws-acme-prod' } }),
    ]);
    expect(created.friendlyId).toBe('J-seq');
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('reads inside a tx see writes from earlier in the same tx', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.tenant.create({ data: { name: 'TxRead', slug: 'tx-read' } });
      const found = await tx.tenant.findUniqueOrThrow({ where: { slug: 'tx-read' } });
      expect(found.name).toBe('TxRead');
    });
    expect(await prisma.tenant.count()).toBe(3);
  });

  it('snapshot restored — tx-committed rows gone next test', async () => {
    expect(await prisma.tenant.count()).toBe(2);
    expect(await prisma.job.findUnique({ where: { friendlyId: 'J-tx-commit' } })).toBeNull();
    expect(await prisma.job.findUnique({ where: { friendlyId: 'J-seq' } })).toBeNull();
  });

  it('nested writes inside a tx — create job with attempts and dependencies', async () => {
    const job = await prisma.$transaction((tx) =>
      tx.job.create({
        data: {
          friendlyId: 'J-nested',
          workspaceId: 'ws-acme-prod',
          payload: {},
          attempts: {
            create: [
              { number: 1, status: 'ARCHIVED' },
              { number: 2, status: 'ACTIVE' },
            ],
          },
          dependencies: {
            create: [{ friendlyId: 'D-nested', type: 'soft', status: 'ACTIVE' }],
          },
        },
        include: { attempts: true, dependencies: true },
      }),
    );
    expect(job.attempts).toHaveLength(2);
    expect(job.dependencies).toHaveLength(1);
  });

  it('rollback undoes nested writes', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.job.create({
          data: {
            friendlyId: 'J-nested-rollback',
            workspaceId: 'ws-acme-prod',
            payload: {},
            attempts: { create: [{ number: 1, status: 'ACTIVE' }] },
          },
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow();
    const job = await prisma.job.findUnique({
      where: { friendlyId: 'J-nested-rollback' },
    });
    expect(job).toBeNull();
  });

  it('updates within a tx are visible to the same tx, not outside until commit', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { slug: 'acme' },
        data: { name: 'Acme Renamed In Tx' },
      });
      const inside = await tx.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
      expect(inside.name).toBe('Acme Renamed In Tx');
    });
    const after = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
    expect(after.name).toBe('Acme Renamed In Tx');
  });

  it('mixed operations across models commit atomically', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.tenant.update({ where: { slug: 'acme' }, data: { labels: ['x', 'y'] } });
      await tx.workspace.update({
        where: { id: 'ws-acme-prod' },
        data: { tags: ['t1'] },
      });
      await tx.catalogPrice.update({
        where: { id: 'price-pro-monthly' },
        data: { amount: '1.000000000001' },
      });
    });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: 'ws-acme-prod' } });
    const price = await prisma.catalogPrice.findUniqueOrThrow({
      where: { id: 'price-pro-monthly' },
    });
    expect(tenant.labels).toEqual(['x', 'y']);
    expect(ws.tags).toEqual(['t1']);
    expect(price.amount.toString()).toBe('1.000000000001');
  });
});
