// Integration coverage for the createBridgeTest fixture API, running against
// a real PGlite and the real generated PrismaClient.
//
// Teardown (the bridge closing when its scope ends) is deliberately not
// asserted here: file/worker scope teardown runs after every test in this
// file has finished, so no test position can observe it.
import { PrismaClient } from '@prisma/client';
import { describe, expect } from 'vitest';

import { PGliteBridge } from '../../index.ts';
import { createBridgeTest } from '../../vitest/index.ts';

// Module-level captures let later tests assert that setup ran once per scope
// and that the underlying instances are shared across tests.
let seedRuns = 0;
let filePglite: PGliteBridge['pglite'] | undefined;
let workerPglite: PGliteBridge['pglite'] | undefined;

const test = createBridgeTest({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  seed: async (client) => {
    seedRuns += 1;
    await client.tenant.create({
      data: { id: 'tenant-fixture', name: 'Fixture Tenant', slug: 'fixture' },
    });
  },
});

describe('createBridgeTest with the default file scope', () => {
  test('provides the bridge and the seeded client', async ({ prisma, bridge }) => {
    expect(bridge).toBeInstanceOf(PGliteBridge);
    filePglite = bridge.pglite;

    const tenants = await prisma.tenant.findMany();
    expect(tenants.map((t) => t.slug)).toEqual(['fixture']);

    // Extra row for the next test to prove the prisma fixture resets.
    await prisma.tenant.create({ data: { name: 'Extra', slug: 'extra' } });
    expect(await prisma.tenant.count()).toBe(2);
  });

  test('resets to the seeded snapshot before each test taking prisma', async ({ prisma }) => {
    const tenants = await prisma.tenant.findMany();
    expect(tenants.map((t) => t.slug)).toEqual(['fixture']);
    // The full setup (bridge, migrations, client, seed, snapshot) ran once
    // for the file scope — not once per test.
    expect(seedRuns).toBe(1);
  });

  test('shares one bridge instance across every test in the file', async ({ prisma, bridge }) => {
    expect(bridge.pglite).toBe(filePglite);
    // Same underlying database: the seeded row is served through it.
    expect(await prisma.tenant.count()).toBe(1);
  });
});

// Within a single test file, 'worker' scope behaves exactly like 'file'
// scope: one bridge, per-test reset. The cross-file sharing that makes
// 'worker' distinct is vitest's own fixture contract (vitest >= 3.2) and is
// not observable from inside one file, so this is a smoke test.
const wtest = createBridgeTest({
  scope: 'worker',
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
});

describe('createBridgeTest with scope: worker', () => {
  wtest('provides a worker-scoped bridge with an empty snapshot', async ({ prisma, bridge }) => {
    expect(bridge).toBeInstanceOf(PGliteBridge);
    workerPglite = bridge.pglite;

    // No seed: the snapshot captures the empty post-migration state.
    expect(await prisma.tenant.count()).toBe(0);
    await prisma.tenant.create({ data: { name: 'Worker', slug: 'worker-scoped' } });
    expect(await prisma.tenant.count()).toBe(1);
  });

  wtest(
    'reuses the same pglite instance and resets data between tests',
    async ({ prisma, bridge }) => {
      expect(bridge.pglite).toBe(workerPglite);
      expect(await prisma.tenant.count()).toBe(0);
    },
  );
});

// scope: 'test' — a fresh bridge per test. The costliest scope (full WASM
// cold start per test) and the only one safe for `test.concurrent`: no
// shared session, no reset contention.
const ttest = createBridgeTest({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  scope: 'test',
  bridge: { statsLevel: 'basic' },
});

let testScopePglite: unknown;

describe('createBridgeTest with scope: test', () => {
  ttest('creates a fresh bridge and skips the redundant reset', async ({ prisma, bridge }) => {
    testScopePglite = bridge.pglite;
    expect(await prisma.tenant.count()).toBe(0);
    await prisma.tenant.create({ data: { name: 'Ephemeral', slug: 'ephemeral' } });

    // A fresh instance is already at snapshot state, so the prisma fixture
    // must not have spent a reset cycle on it.
    const stats = await bridge.stats();
    expect(stats?.resetDbCalls).toBe(0);
  });

  ttest('gives the next test its own instance', async ({ prisma, bridge }) => {
    expect(bridge.pglite).not.toBe(testScopePglite);
    // The previous test's row died with its bridge.
    expect(await prisma.tenant.count()).toBe(0);
  });
});

// scope: 'test' with a seed — exercises the per-file template + per-test load
// path: the seed runs once (in the template), every test loads a fresh
// instance already holding the seeded rows, and writes never leak across tests.
let templateSeedRuns = 0;
const seededTest = createBridgeTest({
  client: (adapter) => new PrismaClient({ adapter }),
  migrations: true,
  scope: 'test',
  seed: async (client) => {
    templateSeedRuns += 1;
    await client.tenant.create({
      data: { id: 'tenant-template', name: 'Template Tenant', slug: 'template' },
    });
  },
});

describe('createBridgeTest with scope: test and a seed', () => {
  seededTest('loads each test from the seeded template', async ({ prisma }) => {
    expect((await prisma.tenant.findMany()).map((t) => t.slug)).toEqual(['template']);
    // Mutate this instance; the next test must not observe the extra row.
    await prisma.tenant.create({ data: { name: 'Local', slug: 'local' } });
    expect(await prisma.tenant.count()).toBe(2);
  });

  seededTest('gives the next test a fresh seeded instance', async ({ prisma }) => {
    // The prior test's extra row died with its instance; the seed survives.
    expect((await prisma.tenant.findMany()).map((t) => t.slug)).toEqual(['template']);
    // The seed ran once — for the file's template — not once per test.
    expect(templateSeedRuns).toBe(1);
  });

  // `test.concurrent` isn't exercised here: this integration project installs a
  // global `beforeEach` that resets a shared single-session bridge (see
  // utils/setup.ts), so running any test concurrently collides on that shared
  // context — the exact hazard the cookbook warns about, unrelated to the
  // per-test instances. Concurrent isolation of the load path is covered
  // directly: independent PGlite instances loaded concurrently from one shared
  // dump each see only the seed plus their own writes.
});
