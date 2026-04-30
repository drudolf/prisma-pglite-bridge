import { describe, expect, it } from 'vitest';

import { prisma } from './app/util/prisma.ts';

describe('channels + items', () => {
  it('reads seeded channels per workspace', async () => {
    const channels = await prisma.channel.findMany({
      where: { workspaceId: 'ws-acme-prod' },
      orderBy: { name: 'asc' },
    });
    expect(channels.map((c) => c.name)).toEqual(['fast', 'slow']);
    expect(channels.find((c) => c.name === 'slow')?.type).toBe('LIFO');
  });

  it('rejects duplicate (workspaceId, name)', async () => {
    await expect(
      prisma.channel.create({
        data: { friendlyId: 'CH-DUP', name: 'fast', workspaceId: 'ws-acme-prod' },
      }),
    ).rejects.toThrow();
  });

  it('upserts a channel by composite unique', async () => {
    const upserted = await prisma.channel.upsert({
      where: { workspaceId_name: { workspaceId: 'ws-acme-prod', name: 'fast' } },
      create: { friendlyId: 'CH-NEW', name: 'fast', workspaceId: 'ws-acme-prod' },
      update: { type: 'PRIORITY', concurrencyLimit: 8 },
    });
    expect(upserted.id).toBe('ch-prod-fast');
    expect(upserted.type).toBe('PRIORITY');
    expect(upserted.concurrencyLimit).toBe(8);
  });

  it('item value JSON roundtrips and updates', async () => {
    const fooKey = { workspaceId_key: { workspaceId: 'ws-acme-prod', key: 'foo' } };
    const foo = await prisma.item.findUniqueOrThrow({ where: fooKey });
    expect(foo.value).toEqual({ kind: 'config', enabled: true });
    await prisma.item.update({
      where: fooKey,
      data: { value: { kind: 'config', enabled: false, ttl: 60 } },
    });
    const after = await prisma.item.findUniqueOrThrow({ where: fooKey });
    expect(after.value).toEqual({ kind: 'config', enabled: false, ttl: 60 });
  });

  it('reads item with channels (implicit m2m)', async () => {
    const bar = await prisma.item.findUniqueOrThrow({
      where: { workspaceId_key: { workspaceId: 'ws-acme-prod', key: 'bar' } },
      include: { channels: { orderBy: { name: 'asc' } } },
    });
    expect(bar.channels.map((c) => c.name)).toEqual(['fast', 'slow']);
  });

  it('disconnects an item from a channel', async () => {
    const barKey = { workspaceId_key: { workspaceId: 'ws-acme-prod', key: 'bar' } };
    await prisma.item.update({
      where: barKey,
      data: { channels: { disconnect: [{ id: 'ch-prod-slow' }] } },
    });
    const after = await prisma.item.findUniqueOrThrow({
      where: barKey,
      include: { channels: true },
    });
    expect(after.channels.map((c) => c.id)).toEqual(['ch-prod-fast']);
  });

  it('rejects duplicate (workspaceId, key) on item', async () => {
    await expect(
      prisma.item.create({
        data: { key: 'foo', value: {}, workspaceId: 'ws-acme-prod' },
      }),
    ).rejects.toThrow();
  });

  it('increments item version', async () => {
    const barKey = { workspaceId_key: { workspaceId: 'ws-acme-prod', key: 'bar' } };
    const before = await prisma.item.findUniqueOrThrow({ where: barKey });
    expect(before.version).toBe(2);
    const after = await prisma.item.update({
      where: barKey,
      data: { version: { increment: 1 } },
    });
    expect(after.version).toBe(3);
  });

  it('queries items by channel via relation filter', async () => {
    const inFast = await prisma.item.findMany({
      where: { channels: { some: { id: 'ch-prod-fast' } } },
      orderBy: { key: 'asc' },
    });
    expect(inFast.map((i) => i.key)).toEqual(['bar', 'foo']);
  });

  it('deleting an item severs the m2m link', async () => {
    const foo = await prisma.item.findUniqueOrThrow({
      where: { workspaceId_key: { workspaceId: 'ws-acme-prod', key: 'foo' } },
    });
    await prisma.item.delete({ where: { id: foo.id } });
    const fast = await prisma.channel.findUniqueOrThrow({
      where: { id: 'ch-prod-fast' },
      include: { items: true },
    });
    expect(fast.items.map((i) => i.id)).not.toContain(foo.id);
  });

  it('snapshot restored — both items present, channels intact', async () => {
    expect(await prisma.item.count({ where: { workspaceId: 'ws-acme-prod' } })).toBe(2);
    const bar = await prisma.item.findUniqueOrThrow({
      where: { workspaceId_key: { workspaceId: 'ws-acme-prod', key: 'bar' } },
      include: { channels: true },
    });
    expect(bar.channels).toHaveLength(2);
  });
});
