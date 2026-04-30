import { describe, expect, it } from 'vitest';

import { prisma } from './app/util/prisma.ts';

describe('tenants', () => {
  it('reads seeded tenants by slug', async () => {
    const acme = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
    expect(acme.id).toBe('tenant-acme');
    expect(acme.labels).toEqual(['priority', 'paid']);
    const globex = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'globex' } });
    expect(globex.config).toEqual({ plan: 'starter' });
  });

  it('roundtrips JSON config and JsonB flags', async () => {
    const acme = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
    expect(acme.config).toEqual({ plan: 'enterprise', region: 'us-east' });
    expect(acme.flags).toEqual({ betaUi: true, exportsV2: false });
  });

  it('updates labels array', async () => {
    await prisma.tenant.update({
      where: { slug: 'acme' },
      data: { labels: ['priority', 'paid', 'enterprise'] },
    });
    const after = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
    expect(after.labels).toEqual(['priority', 'paid', 'enterprise']);
  });

  it('resets labels back to seed between tests', async () => {
    const acme = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
    expect(acme.labels).toEqual(['priority', 'paid']);
  });

  it('creates a new tenant and reads it back', async () => {
    const initech = await prisma.tenant.create({
      data: {
        name: 'Initech',
        slug: 'initech',
        labels: ['demo'],
      },
    });
    expect(initech.slug).toBe('initech');
    expect(await prisma.tenant.count()).toBe(3);
  });

  it('count returns to 2 after the create test', async () => {
    expect(await prisma.tenant.count()).toBe(2);
  });

  it('rejects duplicate slug', async () => {
    await expect(prisma.tenant.create({ data: { name: 'Dupe', slug: 'acme' } })).rejects.toThrow();
  });

  it('upserts tenant by slug', async () => {
    await prisma.tenant.upsert({
      where: { slug: 'acme' },
      create: { name: 'unused', slug: 'acme' },
      update: { name: 'Acme Inc. (renamed)' },
    });
    const acme = await prisma.tenant.findUniqueOrThrow({ where: { slug: 'acme' } });
    expect(acme.name).toBe('Acme Inc. (renamed)');
  });

  it('lists tenant users with composite unique violation on duplicate externalId', async () => {
    const users = await prisma.tenantUser.findMany({ where: { tenantId: 'tenant-acme' } });
    expect(users.map((u) => u.externalId).sort()).toEqual(['alice@acme.test', 'bob@acme.test']);
    await expect(
      prisma.tenantUser.create({
        data: { tenantId: 'tenant-acme', externalId: 'alice@acme.test', role: 'MEMBER' },
      }),
    ).rejects.toThrow();
  });

  it('cascades nothing — children must be deleted before tenant', async () => {
    await prisma.channel.deleteMany({ where: { workspace: { tenantId: 'tenant-globex' } } });
    await prisma.tenantUser.deleteMany({ where: { tenantId: 'tenant-globex' } });
    await prisma.workspace.deleteMany({ where: { tenantId: 'tenant-globex' } });
    await prisma.tenant.delete({ where: { slug: 'globex' } });
    expect(await prisma.tenant.findUnique({ where: { slug: 'globex' } })).toBeNull();
  });
});
