import { describe, expect, it } from 'vitest';

import { prisma } from './app/util/prisma.ts';

describe('jobs', () => {
  it('reads seeded active job with workspace include', async () => {
    const job = await prisma.job.findUniqueOrThrow({
      where: { friendlyId: 'J-001' },
      include: { workspace: true },
    });
    expect(job.status).toBe('ACTIVE');
    expect(job.priority).toBe(5);
    expect(job.workspace.slug).toBe('prod');
  });

  it('roundtrips JSON payload and tags', async () => {
    const job = await prisma.job.findUniqueOrThrow({ where: { friendlyId: 'J-001' } });
    expect(job.payload).toEqual({ input: { a: 1, b: 2 } });
    expect(job.tags).toEqual(['urgent', 'audit']);
  });

  it('transitions DRAFT → ACTIVE → ARCHIVED', async () => {
    const draft = await prisma.job.findUniqueOrThrow({ where: { friendlyId: 'J-002' } });
    expect(draft.status).toBe('DRAFT');
    await prisma.job.update({
      where: { friendlyId: 'J-002' },
      data: { status: 'ACTIVE', startedAt: new Date('2026-04-30T00:00:00Z') },
    });
    await prisma.job.update({
      where: { friendlyId: 'J-002' },
      data: { status: 'ARCHIVED', completedAt: new Date('2026-04-30T01:00:00Z') },
    });
    const final = await prisma.job.findUniqueOrThrow({ where: { friendlyId: 'J-002' } });
    expect(final.status).toBe('ARCHIVED');
    expect(final.startedAt?.toISOString()).toBe('2026-04-30T00:00:00.000Z');
    expect(final.completedAt?.toISOString()).toBe('2026-04-30T01:00:00.000Z');
  });

  it('writes and reads error JSON', async () => {
    await prisma.job.update({
      where: { friendlyId: 'J-001' },
      data: { error: { code: 'E_FAIL', message: 'boom', cause: { line: 42 } } },
    });
    const job = await prisma.job.findUniqueOrThrow({ where: { friendlyId: 'J-001' } });
    expect(job.error).toEqual({ code: 'E_FAIL', message: 'boom', cause: { line: 42 } });
  });

  it('finds jobs by tag (GIN index)', async () => {
    const urgent = await prisma.job.findMany({ where: { tags: { has: 'urgent' } } });
    expect(urgent.map((j) => j.friendlyId)).toEqual(['J-001']);
  });

  it('orders jobs by priority desc', async () => {
    await prisma.job.create({
      data: {
        friendlyId: 'J-low',
        priority: 1,
        workspaceId: 'ws-acme-prod',
        payload: {},
      },
    });
    await prisma.job.create({
      data: {
        friendlyId: 'J-high',
        priority: 10,
        workspaceId: 'ws-acme-prod',
        payload: {},
      },
    });
    const ordered = await prisma.job.findMany({
      where: { workspaceId: 'ws-acme-prod' },
      orderBy: { priority: 'desc' },
      select: { friendlyId: true, priority: true },
    });
    expect(ordered[0]?.friendlyId).toBe('J-high');
    expect(ordered[ordered.length - 1]?.friendlyId).toBe('J-low');
  });

  it('groupBy status gives counts of seeded baseline', async () => {
    const grouped = await prisma.job.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const map = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    expect(map.ACTIVE).toBe(1);
    expect(map.DRAFT).toBe(1);
  });

  it('rejects duplicate friendlyId', async () => {
    await expect(
      prisma.job.create({
        data: { friendlyId: 'J-001', workspaceId: 'ws-acme-prod', payload: {} },
      }),
    ).rejects.toThrow();
  });

  it('aggregates priority sum and average', async () => {
    const agg = await prisma.job.aggregate({
      _sum: { priority: true },
      _avg: { priority: true },
    });
    expect(agg._sum.priority).toBe(5);
    expect(agg._avg.priority).toBe(2.5);
  });

  it('updateMany sets all jobs in a workspace to ARCHIVED', async () => {
    const result = await prisma.job.updateMany({
      where: { workspaceId: 'ws-acme-staging' },
      data: { status: 'ARCHIVED' },
    });
    expect(result.count).toBe(1);
    const staged = await prisma.job.findMany({ where: { workspaceId: 'ws-acme-staging' } });
    expect(staged.every((j) => j.status === 'ARCHIVED')).toBe(true);
  });
});
