// Integration coverage for the vitest setup helper, running against a real
// PGlite and the real generated PrismaClient.
//
// The inline-`schema` variant is intentionally not exercised here: pushSchema
// loads the WASM schema engine (slow), and the migrations path covers the same
// helper wiring — pushSchema itself is covered by the src/schema tests.
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';

import { PGliteBridge } from '../../index.ts';
import { setupPGliteBridge } from '../../vitest/index.ts';

// Called at the file's top level so the helper's auto-registered hooks
// (beforeEach → bridge.resetDb, afterAll → bridge.close) apply file-wide.
// The manual/failure contexts below use their own bridge instances, so the
// file-wide reset of this bridge never touches them.
const { prisma, bridge } = await setupPGliteBridge({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  seed: async (client) => {
    await client.tenant.create({
      data: { id: 'tenant-helper', name: 'Helper Tenant', slug: 'helper' },
    });
  },
});

// Hygiene only: disconnect the client alongside the helper's auto-registered
// close. Wrapped in catch so hook ordering relative to close never matters.
afterAll(async () => {
  await prisma.$disconnect().catch(() => undefined);
});

describe('setupPGliteBridge with auto-registered hooks', () => {
  it('resolves a seeded client and the bridge', async () => {
    expect(bridge).toBeInstanceOf(PGliteBridge);
    const tenants = await prisma.tenant.findMany();
    expect(tenants.map((t) => t.slug)).toEqual(['helper']);
    // Extra row for the next test to prove the auto beforeEach reset fires.
    await prisma.tenant.create({ data: { name: 'Extra', slug: 'extra' } });
    expect(await prisma.tenant.count()).toBe(2);
  });

  it('restores the seeded snapshot between tests via the auto beforeEach', async () => {
    const tenants = await prisma.tenant.findMany();
    expect(tenants.map((t) => t.slug)).toEqual(['helper']);
  });
});

describe('setupPGliteBridge with registerHooks: false and snapshot: false', () => {
  it('leaves the lifecycle to the caller and resetDb truncates to empty', async () => {
    // Object form of `migrations` (vs `true` in the main context above)
    // exercises the explicit-options arm of the helper.
    const manual = await setupPGliteBridge({
      client: (adapter) => new PrismaClient({ adapter }),
      migrations: { configRoot: process.cwd() },
      registerHooks: false,
      snapshot: false,
    });
    try {
      // Fresh bridge: no seed ran, and the main context's seeded row must
      // not leak over — separate bridge, separate database.
      expect(await manual.prisma.tenant.count()).toBe(0);

      await manual.prisma.tenant.create({ data: { name: 'Ephemeral', slug: 'ephemeral' } });
      expect(await manual.prisma.tenant.count()).toBe(1);

      // No snapshot was taken, so resetDb truncates back to empty.
      await manual.bridge.resetDb();
      expect(await manual.prisma.tenant.count()).toBe(0);

      // The manual reset did not touch the main bridge — its seeded row is
      // still in place.
      expect(await prisma.tenant.count()).toBe(1);
    } finally {
      await manual.prisma.$disconnect().catch(() => undefined);
      await manual.bridge.close();
    }
  });
});

describe('setupPGliteBridge with an inline schema', () => {
  it('applies the schema via the WASM engine', async () => {
    const ctx = await setupPGliteBridge({
      client: (adapter) => new PrismaClient({ adapter }),
      schema: {
        schema: `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model Standalone {
  id Int @id
}
`,
      },
      registerHooks: false,
      snapshot: false,
    });
    try {
      // The generated PrismaClient doesn't know this model — raw SQL
      // proves the schema engine created the table.
      await ctx.prisma.$executeRaw`INSERT INTO "Standalone" ("id") VALUES (1)`;
      const rows = await ctx.prisma.$queryRaw<{ id: number }[]>`SELECT "id" FROM "Standalone"`;
      expect(rows).toEqual([{ id: 1 }]);
    } finally {
      await ctx.prisma.$disconnect().catch(() => undefined);
      await ctx.bridge.close();
    }
  });
});

describe('setupPGliteBridge seed failure', () => {
  it('rejects with the seed error and closes the bridge before propagating', async () => {
    let seedClient: PrismaClient | undefined;
    await expect(
      setupPGliteBridge({
        client: (adapter) => {
          seedClient = new PrismaClient({ adapter });
          return seedClient;
        },
        migrations: true,
        registerHooks: false,
        seed: () => Promise.reject(new Error('seed boom')),
      }),
    ).rejects.toThrow('seed boom');

    // The helper must have closed the bridge on the failure path: the
    // adapter behind the client no longer serves queries.
    if (!seedClient) throw new Error('client factory was never invoked');
    await expect(seedClient.$queryRaw`SELECT 1`).rejects.toThrow();
    await seedClient.$disconnect().catch(() => undefined);
  });
});
