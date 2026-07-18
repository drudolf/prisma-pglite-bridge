/**
 * Red-first tests for `./pool-jest.ts` — the Jest entry over the pool
 * core, mirroring how `./jest.test.ts` exercises `./jest.ts` under
 * vitest: `@jest/globals` throws when imported outside a Jest run, so it
 * is replaced with spies, and the core's `createPoolContext` (which would
 * spin up a real PGlite) is stubbed. The real core is exercised by
 * `./pool-core.test.ts` and the vitest entry's tests, which share it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { beforeEachSpy, afterAllSpy, createPoolContextSpy } = vi.hoisted(() => ({
  beforeEachSpy: vi.fn(),
  afterAllSpy: vi.fn(),
  createPoolContextSpy: vi.fn(),
}));

vi.mock('@jest/globals', () => ({ beforeEach: beforeEachSpy, afterAll: afterAllSpy }));
vi.mock('./pool-core.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pool-core.ts')>()),
  createPoolContext: createPoolContextSpy,
}));

import { setupPGlitePool } from './pool-jest.ts';

// The suite's `restoreMocks` resets implementations but not call history, and
// these hoisted spies are shared across tests — clear their call records so
// per-test `toHaveBeenCalled` assertions start from zero.
beforeEach(() => {
  vi.clearAllMocks();
});

describe('jest setupPGlitePool hook registration', () => {
  const makeContext = () => ({
    client: { tag: 'client' },
    pool: {},
    pglite: {},
    resetDb: vi.fn(async () => {}),
    snapshotDb: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });

  it('registers beforeEach(resetDb) and afterAll(close) by default and returns the context', async () => {
    const context = makeContext();
    createPoolContextSpy.mockResolvedValueOnce(context);
    const setup = async (): Promise<void> => {};
    const client = () => ({});

    const result = await setupPGlitePool({ setup, client });

    expect(result).toBe(context);
    // The one-call form delegates to the shared core with the caller's options.
    expect(createPoolContextSpy).toHaveBeenCalledTimes(1);
    expect(createPoolContextSpy.mock.calls[0]?.[0]).toMatchObject({ setup, client });
    expect(beforeEachSpy).toHaveBeenCalledTimes(1);
    expect(afterAllSpy).toHaveBeenCalledTimes(1);

    // Drive the registered callbacks to prove they target this context.
    const resetCb = beforeEachSpy.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
    const closeCb = afterAllSpy.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
    expect(resetCb).toBeTypeOf('function');
    expect(closeCb).toBeTypeOf('function');
    await resetCb?.();
    await closeCb?.();
    expect(context.resetDb).toHaveBeenCalledTimes(1);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(context.snapshotDb).not.toHaveBeenCalled();
  });

  it('registers no hooks when registerHooks is false', async () => {
    const context = makeContext();
    createPoolContextSpy.mockResolvedValueOnce(context);

    const result = await setupPGlitePool({
      setup: async () => {},
      client: () => ({}),
      registerHooks: false,
    });

    expect(result).toBe(context);
    expect(beforeEachSpy).not.toHaveBeenCalled();
    expect(afterAllSpy).not.toHaveBeenCalled();
  });
});
