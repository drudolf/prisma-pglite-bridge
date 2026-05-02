import { describe, expect, it } from 'vitest';

import { prisma } from './utils/prisma.ts';

describe('workspaces', () => {
  it('reads seeded workspace with tenant include', async () => {
    const ws = await prisma.workspace.findUniqueOrThrow({
      where: { id: 'ws-acme-prod' },
      include: { tenant: true },
    });
    expect(ws.name).toBe('Acme Prod');
    expect(ws.tenant.slug).toBe('acme');
  });

  it('roundtrips Decimal rateLimit precision', async () => {
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: 'ws-acme-prod' } });
    expect(ws.rateLimit.toString()).toBe('12.5');
    const updated = await prisma.workspace.update({
      where: { id: 'ws-acme-prod' },
      data: { rateLimit: '99.99' },
    });
    expect(updated.rateLimit.toString()).toBe('99.99');
  });

  it('default rateLimit applies on create without value', async () => {
    const ws = await prisma.workspace.create({
      data: {
        name: 'Acme Dev',
        slug: 'dev',
        apiKey: 'key-acme-dev',
        tenantId: 'tenant-acme',
      },
    });
    expect(ws.rateLimit.toString()).toBe('5');
  });

  it('settings JSON default is {}', async () => {
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { id: 'ws-globex-main' } });
    expect(ws.settings).toEqual({});
  });

  it('updates tags array', async () => {
    await prisma.workspace.update({
      where: { id: 'ws-acme-prod' },
      data: { tags: { push: 'perf' } },
    });
    const after = await prisma.workspace.findUniqueOrThrow({ where: { id: 'ws-acme-prod' } });
    expect(after.tags).toEqual(['prod', 'critical', 'perf']);
  });

  it('rejects duplicate apiKey', async () => {
    await expect(
      prisma.workspace.create({
        data: {
          name: 'Dupe',
          slug: 'dupe',
          apiKey: 'key-acme-prod',
          tenantId: 'tenant-acme',
        },
      }),
    ).rejects.toThrow();
  });

  it('rejects duplicate (tenantId, slug)', async () => {
    await expect(
      prisma.workspace.create({
        data: {
          name: 'Dupe',
          slug: 'prod',
          apiKey: 'key-fresh',
          tenantId: 'tenant-acme',
        },
      }),
    ).rejects.toThrow();
  });

  it('counts workspaces per tenant', async () => {
    const acmeCount = await prisma.workspace.count({ where: { tenantId: 'tenant-acme' } });
    const globexCount = await prisma.workspace.count({ where: { tenantId: 'tenant-globex' } });
    expect(acmeCount).toBe(2);
    expect(globexCount).toBe(1);
  });

  it('finds workspaces by tag', async () => {
    const critical = await prisma.workspace.findMany({ where: { tags: { has: 'critical' } } });
    expect(critical.map((w) => w.id)).toEqual(['ws-acme-prod']);
  });

  it('groupBy tenantId returns counts', async () => {
    const grouped = await prisma.workspace.groupBy({
      by: ['tenantId'],
      _count: { _all: true },
      orderBy: { tenantId: 'asc' },
    });
    expect(grouped).toEqual([
      { tenantId: 'tenant-acme', _count: { _all: 2 } },
      { tenantId: 'tenant-globex', _count: { _all: 1 } },
    ]);
  });
});
