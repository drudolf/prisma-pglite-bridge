import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { PGliteBridge } from '../pglite-bridge';

// `@jest/globals` throws when imported outside a Jest run, and these tests
// assert on hook registration — so replace it with spies (and stub the core's
// createBridgeContext, which would otherwise spin up a real PGlite) before the
// module under test is imported. `vi.hoisted` makes the spies exist above the
// hoisted `vi.mock` factories. The real createBridgeContext is exercised by the
// vitest integration helper, which shares this exact core.
const { beforeEachSpy, afterAllSpy, createBridgeContextSpy } = vi.hoisted(() => ({
  beforeEachSpy: vi.fn(),
  afterAllSpy: vi.fn(),
  createBridgeContextSpy: vi.fn(),
}));

vi.mock('@jest/globals', () => ({ beforeEach: beforeEachSpy, afterAll: afterAllSpy }));
vi.mock('./core.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./core.ts')>()),
  createBridgeContext: createBridgeContextSpy,
}));

import {
  type PGliteTestContext,
  type SetupPGliteBridgeOptions,
  setupPGliteBridge,
} from './jest.ts';

// The suite's `restoreMocks` resets implementations but not call history, and
// these hoisted spies are shared across tests — clear their call records so
// per-test `toHaveBeenCalled` assertions start from zero.
beforeEach(() => {
  vi.clearAllMocks();
});

// Validation must reject before any bridge work, so the client factory and the
// core are never touched on the misconfigured paths.
describe('jest setupPGliteBridge option validation', () => {
  it('rejects with a TypeError mentioning "exactly one" when both migrations and schema are given', async () => {
    const client = vi.fn(() => ({}));
    const rejection = setupPGliteBridge({
      client,
      migrations: true,
      schema: { schema: 'model Empty { id Int @id }' },
    });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow('exactly one');
    expect(client).not.toHaveBeenCalled();
    expect(createBridgeContextSpy).not.toHaveBeenCalled();
  });

  it('rejects with a TypeError mentioning "exactly one" when neither migrations nor schema is given', async () => {
    const rejection = setupPGliteBridge({ client: () => ({}) });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow('exactly one');
    expect(createBridgeContextSpy).not.toHaveBeenCalled();
  });

  it('reports its own name, not the core builder it delegates to', async () => {
    await expect(setupPGliteBridge({ client: () => ({}) })).rejects.toThrow(
      'setupPGliteBridge requires exactly one of `migrations` or `schema`',
    );
  });
});

// Backcompat pin mirroring vitest.test.ts (design D.2): the Jest entry keeps
// `registerHooks` on `SetupPGliteBridgeOptions`, and the context gained
// `close` without losing `prisma`/`bridge`. tsc enforces both.
describe('jest setupPGliteBridge public type backcompat', () => {
  interface FakeClient {
    readonly tag: 'fake';
  }

  it('accepts the pre-change option object, registerHooks included', () => {
    const preChange = {
      client: (): FakeClient => ({ tag: 'fake' }),
      migrations: true as const,
      seed: async (_client: FakeClient): Promise<void> => {},
      snapshot: false,
      registerHooks: false,
      bridge: { statsLevel: 'basic' as const },
    };
    expectTypeOf(preChange).toExtend<SetupPGliteBridgeOptions<FakeClient>>();
  });

  it('PGliteTestContext exposes exactly prisma, bridge and close', () => {
    expectTypeOf<keyof PGliteTestContext<FakeClient>>().toEqualTypeOf<
      'prisma' | 'bridge' | 'close'
    >();
    expectTypeOf<PGliteTestContext<FakeClient>['bridge']>().toEqualTypeOf<PGliteBridge>();
    expectTypeOf<PGliteTestContext<FakeClient>['close']>().toEqualTypeOf<() => Promise<void>>();
  });
});

describe('jest setupPGliteBridge hook registration', () => {
  const makeContext = () => {
    const bridge = { resetDb: vi.fn(async () => {}), close: vi.fn(async () => {}) };
    return { prisma: { tag: 'client' }, bridge };
  };

  it('registers beforeEach(resetDb) and afterAll(close) by default and returns the context', async () => {
    const context = makeContext();
    createBridgeContextSpy.mockResolvedValueOnce(context);

    const result = await setupPGliteBridge({ client: () => ({}), migrations: true });

    expect(result).toBe(context);
    expect(beforeEachSpy).toHaveBeenCalledTimes(1);
    expect(afterAllSpy).toHaveBeenCalledTimes(1);

    // Drive the registered callbacks to prove they target this bridge.
    const resetCb = beforeEachSpy.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
    const closeCb = afterAllSpy.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
    expect(resetCb).toBeTypeOf('function');
    expect(closeCb).toBeTypeOf('function');
    await resetCb?.();
    await closeCb?.();
    expect(context.bridge.resetDb).toHaveBeenCalledTimes(1);
    expect(context.bridge.close).toHaveBeenCalledTimes(1);
  });

  it('registers no hooks when registerHooks is false', async () => {
    const context = makeContext();
    createBridgeContextSpy.mockResolvedValueOnce(context);

    const result = await setupPGliteBridge({
      client: () => ({}),
      migrations: true,
      registerHooks: false,
    });

    expect(result).toBe(context);
    expect(beforeEachSpy).not.toHaveBeenCalled();
    expect(afterAllSpy).not.toHaveBeenCalled();
  });
});
