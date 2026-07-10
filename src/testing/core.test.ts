import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBridgeContext, createBridgeContextFromDump } from './core.ts';

// Drive the failure/teardown path in isolation: a fake bridge whose close()
// rejects, with schema apply stubbed so no real PGlite spins up. Success paths
// are covered by the vitest integration helper against a real PGlite; here we
// only pin the error-precedence contract. The bridge is a class (not a vi.fn)
// so the suite's `restoreMocks` can't wipe the constructor between tests.
const { closeSpy, pgliteCloseSpy } = vi.hoisted(() => ({
  closeSpy: vi.fn(),
  pgliteCloseSpy: vi.fn(),
}));

// The instances createBridgeContextFromDump builds are unreachable when setup
// fails, so close() is asserted through module-level spies instead of real
// prototypes — same isolation style as the bridge mock below.
vi.mock('@electric-sql/pglite', () => ({
  PGlite: class {
    close = pgliteCloseSpy;
  },
}));

vi.mock('../pglite-bridge', () => ({
  PGliteBridge: class {
    pglite = {};
    adapter = {};
    snapshotDb = () => Promise.resolve();
    close = closeSpy;

    // Mirror the real constructor's synchronous statsLevel guard (see
    // src/pglite-bridge/index.ts) — the remaining synchronous constructor
    // throw now that per-client statement names allow caching at any max.
    constructor(options?: { statsLevel?: string }) {
      const statsLevel = options?.statsLevel ?? 'off';
      if (statsLevel !== 'off' && statsLevel !== 'basic' && statsLevel !== 'full') {
        throw new Error(`statsLevel must be 'off', 'basic', or 'full'; got ${String(statsLevel)}`);
      }
    }
  },
}));
vi.mock('../schema', () => ({ pushSchema: () => Promise.resolve() }));
vi.mock('../schema/migrations.ts', () => ({ pushMigrations: () => Promise.resolve() }));

describe('createBridgeContext failure handling', () => {
  it('closes the bridge and propagates the original setup error even when close() also fails', async () => {
    closeSpy.mockRejectedValueOnce(new Error('close boom'));

    await expect(
      createBridgeContext({
        client: () => ({}),
        migrations: true,
        seed: () => Promise.reject(new Error('seed boom')),
      }),
    ).rejects.toThrow('seed boom');

    // Cleanup still ran; its rejection was swallowed rather than masking the
    // seed error above.
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

describe('createBridgeContextFromDump failure handling', () => {
  // The dump is never read: the mocked PGlite ignores loadDataDir entirely.
  const dump = new Blob(['unused-by-the-mocked-pglite']);

  // The hoisted spies are plain vi.fn()s, which the suite's `restoreMocks`
  // does not reset — wipe them here so calls from other tests cannot leak in.
  beforeEach(() => {
    closeSpy.mockReset().mockResolvedValue(undefined);
    pgliteCloseSpy.mockReset().mockResolvedValue(undefined);
  });

  it('closes the bridge and the loaded PGlite when the client factory throws', async () => {
    await expect(
      createBridgeContextFromDump(dump, {
        client: () => {
          throw new Error('factory boom');
        },
      }),
    ).rejects.toThrow('factory boom');

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pgliteCloseSpy).toHaveBeenCalledOnce();
  });

  it('closes the loaded PGlite when the bridge constructor throws', async () => {
    await expect(
      createBridgeContextFromDump(dump, {
        client: () => ({}),
        bridge: { statsLevel: 'invalid' as 'basic' },
      }),
    ).rejects.toThrow(/statsLevel/);

    expect(pgliteCloseSpy).toHaveBeenCalledOnce();
    // No bridge was ever constructed, so there is nothing to close there.
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('propagates the setup error even when the teardown itself fails', async () => {
    closeSpy.mockRejectedValueOnce(new Error('bridge teardown boom'));
    pgliteCloseSpy.mockRejectedValueOnce(new Error('pglite teardown boom'));

    await expect(
      createBridgeContextFromDump(dump, {
        client: () => {
          throw new Error('factory boom');
        },
      }),
    ).rejects.toThrow('factory boom');

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pgliteCloseSpy).toHaveBeenCalledOnce();
  });
});
