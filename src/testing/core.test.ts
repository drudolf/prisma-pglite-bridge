import { describe, expect, it, vi } from 'vitest';

import { createBridgeContext } from './core.ts';

// Drive the failure/teardown path in isolation: a fake bridge whose close()
// rejects, with schema apply stubbed so no real PGlite spins up. Success paths
// are covered by the vitest integration helper against a real PGlite; here we
// only pin the error-precedence contract. The bridge is a class (not a vi.fn)
// so the suite's `restoreMocks` can't wipe the constructor between tests.
const { closeSpy } = vi.hoisted(() => ({ closeSpy: vi.fn() }));

vi.mock('../pglite-bridge', () => ({
  PGliteBridge: class {
    pglite = {};
    adapter = {};
    snapshotDb = () => Promise.resolve();
    close = closeSpy;
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
