import { describe, expect, it } from 'vitest';

import { prisma } from './utils/prisma.ts';

describe('dependencies + batches + snapshots', () => {
  it('reads seeded dependency on the active job', async () => {
    const deps = await prisma.dependency.findMany({ where: { jobId: 'job-active' } });
    expect(deps).toHaveLength(1);
    expect(deps[0]?.friendlyId).toBe('D-001');
    expect(deps[0]?.status).toBe('ACTIVE');
  });

  it('resolves a dependency with timestamp', async () => {
    const at = new Date('2026-04-30T12:00:00Z');
    await prisma.dependency.update({
      where: { id: 'dep-1' },
      data: { status: 'ARCHIVED', resolvedAt: at, output: { ok: true } },
    });
    const after = await prisma.dependency.findUniqueOrThrow({ where: { id: 'dep-1' } });
    expect(after.status).toBe('ARCHIVED');
    expect(after.resolvedAt?.toISOString()).toBe('2026-04-30T12:00:00.000Z');
    expect(after.output).toEqual({ ok: true });
  });

  it('reads seeded batch and its job link', async () => {
    const batch = await prisma.batch.findUniqueOrThrow({
      where: { friendlyId: 'B-001' },
      include: { jobs: true },
    });
    expect(batch.metadata).toEqual({ kicker: 'manual' });
    expect(batch.jobs.map((j) => j.friendlyId)).toEqual(['J-001']);
  });

  it('moves a job between batches', async () => {
    const newBatch = await prisma.batch.create({
      data: { friendlyId: 'B-NEW', status: 'DRAFT' },
    });
    await prisma.job.update({
      where: { id: 'job-active' },
      data: { batchId: newBatch.id },
    });
    const active = await prisma.job.findUniqueOrThrow({
      where: { id: 'job-active' },
      include: { batch: true },
    });
    expect(active.batch?.friendlyId).toBe('B-NEW');
  });

  it('detaches a job from its batch by setting batchId null', async () => {
    await prisma.job.update({
      where: { id: 'job-active' },
      data: { batchId: null },
    });
    const j = await prisma.job.findUniqueOrThrow({ where: { id: 'job-active' } });
    expect(j.batchId).toBeNull();
  });

  it('reads seeded snapshot data', async () => {
    const snap = await prisma.snapshot.findUniqueOrThrow({ where: { id: 'snap-1' } });
    expect(snap.data).toEqual({ state: 'pre-run', sequence: 0 });
    expect(snap.isValid).toBe(true);
  });

  it('appends a new snapshot for a job', async () => {
    const created = await prisma.snapshot.create({
      data: { jobId: 'job-active', data: { state: 'mid-run', sequence: 1 } },
    });
    expect(created.isValid).toBe(true);
    const all = await prisma.snapshot.findMany({
      where: { jobId: 'job-active' },
      orderBy: { createdAt: 'desc' },
    });
    expect(all.map((s) => (s.data as { sequence: number }).sequence)).toContain(1);
  });

  it('invalidates a snapshot', async () => {
    await prisma.snapshot.update({
      where: { id: 'snap-1' },
      data: { isValid: false },
    });
    const valid = await prisma.snapshot.count({
      where: { jobId: 'job-active', isValid: true },
    });
    expect(valid).toBe(0);
  });

  it('deletes job cascades dependencies and snapshots', async () => {
    const tmp = await prisma.job.create({
      data: {
        friendlyId: 'J-tmp',
        workspaceId: 'ws-acme-prod',
        payload: {},
        dependencies: {
          create: [{ friendlyId: 'D-tmp', type: 'soft', status: 'ACTIVE' }],
        },
        snapshots: {
          create: [{ data: { state: 'tmp', sequence: 0 } }],
        },
      },
      include: { dependencies: true, snapshots: true },
    });
    expect(tmp.dependencies).toHaveLength(1);
    expect(tmp.snapshots).toHaveLength(1);
    await prisma.job.delete({ where: { id: tmp.id } });
    const deps = await prisma.dependency.findMany({ where: { jobId: tmp.id } });
    const snaps = await prisma.snapshot.findMany({ where: { jobId: tmp.id } });
    expect(deps).toEqual([]);
    expect(snaps).toEqual([]);
  });

  it('snapshot restored — baseline still 1 dep, 1 snap', async () => {
    expect(await prisma.dependency.count()).toBe(1);
    expect(await prisma.snapshot.count()).toBe(1);
  });
});
