import { describe, expect, it } from 'vitest';

import { prisma } from './app/util/prisma.ts';

describe('attempts', () => {
  it('reads seeded attempts ordered by number', async () => {
    const attempts = await prisma.attempt.findMany({
      where: { jobId: 'job-active' },
      orderBy: { number: 'asc' },
    });
    expect(attempts.map((a) => a.number)).toEqual([1, 2]);
    expect(attempts[0]?.status).toBe('ARCHIVED');
    expect(attempts[1]?.status).toBe('ACTIVE');
  });

  it('finds attempt by composite unique (jobId, number)', async () => {
    const a = await prisma.attempt.findUniqueOrThrow({
      where: { jobId_number: { jobId: 'job-active', number: 1 } },
    });
    expect(a.id).toBe('att-1-1');
  });

  it('rejects duplicate (jobId, number)', async () => {
    await expect(
      prisma.attempt.create({
        data: { jobId: 'job-active', number: 1, status: 'ACTIVE' },
      }),
    ).rejects.toThrow();
  });

  it('roundtrips output JSON', async () => {
    const a = await prisma.attempt.findUniqueOrThrow({ where: { id: 'att-1-1' } });
    expect(a.output).toEqual({ stdout: 'first run' });
    await prisma.attempt.update({
      where: { id: 'att-1-2' },
      data: { output: { stdout: 'second run', exitCode: 0 } },
    });
    const after = await prisma.attempt.findUniqueOrThrow({ where: { id: 'att-1-2' } });
    expect(after.output).toEqual({ stdout: 'second run', exitCode: 0 });
  });

  it('sets completedAt and reads with deep include', async () => {
    await prisma.attempt.update({
      where: { id: 'att-1-2' },
      data: { status: 'ARCHIVED', completedAt: new Date('2026-04-30T00:00:00Z') },
    });
    const job = await prisma.job.findUniqueOrThrow({
      where: { id: 'job-active' },
      include: { attempts: { orderBy: { number: 'asc' } } },
    });
    expect(job.attempts.every((a) => a.status === 'ARCHIVED')).toBe(true);
  });

  it('appends a new attempt #3', async () => {
    const a = await prisma.attempt.create({
      data: { jobId: 'job-active', number: 3, status: 'ACTIVE' },
    });
    expect(a.number).toBe(3);
    const count = await prisma.attempt.count({ where: { jobId: 'job-active' } });
    expect(count).toBe(3);
  });

  it('snapshot restored — back to 2 attempts after the create', async () => {
    const count = await prisma.attempt.count({ where: { jobId: 'job-active' } });
    expect(count).toBe(2);
  });

  it('deleting job cascades attempts', async () => {
    const probeJob = await prisma.job.create({
      data: {
        friendlyId: 'J-probe',
        workspaceId: 'ws-acme-prod',
        payload: {},
        attempts: {
          create: [
            { number: 1, status: 'ACTIVE' },
            { number: 2, status: 'ACTIVE' },
          ],
        },
      },
      include: { attempts: true },
    });
    expect(probeJob.attempts).toHaveLength(2);
    await prisma.job.delete({ where: { id: probeJob.id } });
    const remaining = await prisma.attempt.findMany({ where: { jobId: probeJob.id } });
    expect(remaining).toEqual([]);
  });

  it('counts attempts per status across the suite', async () => {
    const grouped = await prisma.attempt.groupBy({
      by: ['status'],
      _count: { _all: true },
    });
    const map = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    expect(map.ARCHIVED).toBe(1);
    expect(map.ACTIVE).toBe(1);
  });

  it('updateMany marks all active attempts archived', async () => {
    const result = await prisma.attempt.updateMany({
      where: { status: 'ACTIVE' },
      data: { status: 'ARCHIVED' },
    });
    expect(result.count).toBe(1);
  });
});
