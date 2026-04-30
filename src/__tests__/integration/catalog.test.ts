import { describe, expect, it } from 'vitest';

import { prisma } from './app/util/prisma.ts';

describe('catalog', () => {
  it('reads seeded catalog entry with deep include', async () => {
    const entry = await prisma.catalogEntry.findUniqueOrThrow({
      where: { friendlyId: 'PRO' },
      include: { tiers: { include: { prices: { orderBy: { kind: 'asc' } } } } },
    });
    expect(entry.capabilities).toEqual(['billing', 'reports']);
    expect(entry.tiers).toHaveLength(1);
    expect(entry.tiers[0]?.prices).toHaveLength(2);
  });

  it('roundtrips Decimal(20,12) precision', async () => {
    const monthly = await prisma.catalogPrice.findUniqueOrThrow({
      where: { id: 'price-pro-monthly' },
    });
    const yearly = await prisma.catalogPrice.findUniqueOrThrow({
      where: { id: 'price-pro-yearly' },
    });
    expect(monthly.amount.toString()).toBe('49.999999999999');
    expect(yearly.amount.toString()).toBe('499.000000000001');
  });

  it('updates a price with high-precision Decimal', async () => {
    await prisma.catalogPrice.update({
      where: { id: 'price-pro-monthly' },
      data: { amount: '12.345678901234' },
    });
    const after = await prisma.catalogPrice.findUniqueOrThrow({
      where: { id: 'price-pro-monthly' },
    });
    expect(after.amount.toString()).toBe('12.345678901234');
  });

  it('rejects duplicate (tierId, kind)', async () => {
    await expect(
      prisma.catalogPrice.create({
        data: { tierId: 'tier-pro-default', kind: 'monthly', amount: '0.01' },
      }),
    ).rejects.toThrow();
  });

  it('upserts a price by composite unique', async () => {
    const upserted = await prisma.catalogPrice.upsert({
      where: { tierId_kind: { tierId: 'tier-pro-default', kind: 'monthly' } },
      create: { tierId: 'tier-pro-default', kind: 'monthly', amount: '0.01' },
      update: { amount: '99.999999999999' },
    });
    expect(upserted.amount.toString()).toBe('99.999999999999');
  });

  it('finds entries by name index', async () => {
    const matches = await prisma.catalogEntry.findMany({ where: { name: 'Pro' } });
    expect(matches.map((e) => e.friendlyId)).toEqual(['PRO']);
  });

  it('roundtrips JsonB conditions on tier', async () => {
    const tier = await prisma.catalogTier.findUniqueOrThrow({
      where: { id: 'tier-pro-default' },
    });
    expect(tier.conditions).toEqual([{ kind: 'always' }]);
    await prisma.catalogTier.update({
      where: { id: 'tier-pro-default' },
      data: { conditions: [{ kind: 'always' }, { kind: 'region', value: 'us' }] },
    });
    const after = await prisma.catalogTier.findUniqueOrThrow({
      where: { id: 'tier-pro-default' },
    });
    expect(after.conditions).toEqual([{ kind: 'always' }, { kind: 'region', value: 'us' }]);
  });

  it('updates capabilities array', async () => {
    await prisma.catalogEntry.update({
      where: { friendlyId: 'PRO' },
      data: { capabilities: ['billing', 'reports', 'sso'] },
    });
    const after = await prisma.catalogEntry.findUniqueOrThrow({
      where: { friendlyId: 'PRO' },
    });
    expect(after.capabilities).toEqual(['billing', 'reports', 'sso']);
  });

  it('cascades tier delete → prices', async () => {
    const tier = await prisma.catalogTier.create({
      data: {
        name: 'tmp',
        entryId: 'cat-pro',
        prices: { create: [{ kind: 'one-off', amount: '1.00' }] },
      },
      include: { prices: true },
    });
    expect(tier.prices).toHaveLength(1);
    await prisma.catalogTier.delete({ where: { id: tier.id } });
    const prices = await prisma.catalogPrice.findMany({ where: { tierId: tier.id } });
    expect(prices).toEqual([]);
  });

  it('snapshot restored — capabilities back to seeded value', async () => {
    const entry = await prisma.catalogEntry.findUniqueOrThrow({
      where: { friendlyId: 'PRO' },
    });
    expect(entry.capabilities).toEqual(['billing', 'reports']);
  });
});
