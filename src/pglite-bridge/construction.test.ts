import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockPGlite } from '../__tests__/mocks.ts';

/**
 * Constructor-ordering pins for PGliteBridge: pool `max` validation must run
 * in the constructor's validate-before-create block, BEFORE the bridge
 * creates its owned PGlite — otherwise a rejected configuration orphans a
 * freshly booted WASM instance (~135 MB eagerly initialized, unreachable
 * until GC).
 *
 * Lives in its own file rather than index.test.ts: these tests swap
 * `@electric-sql/pglite` for a constructor spy via the repo's established
 * vi.doMock + vi.resetModules + dynamic-import dance (see the PrismaPg
 * failure-path tests in index.test.ts), while index.test.ts boots a real
 * PGlite at module scope that must stay unmocked.
 */

type BridgeModule = typeof import('./index.ts');

/**
 * Fresh module registry with `@electric-sql/pglite` replaced by a
 * constructor spy that hands back a stub instance. The spy call count is
 * the observable for "no PGlite was constructed".
 */
const importBridgeWithPGliteSpy = async (): Promise<{
  bridgeModule: BridgeModule;
  pgliteCtor: ReturnType<typeof vi.fn>;
}> => {
  vi.resetModules();
  const pgliteCtor = vi.fn().mockImplementation(function MockPGlite() {
    return createMockPGlite();
  });
  vi.doMock('@electric-sql/pglite', () => ({ PGlite: pgliteCtor }));
  const bridgeModule = await import('./index.ts');
  return { bridgeModule, pgliteCtor };
};

afterEach(() => {
  vi.doUnmock('@electric-sql/pglite');
  vi.resetModules();
});

describe('PGliteBridge — max validation before PGlite creation', () => {
  it.each([
    0, 1.5, -1,
  ])('rejects max: %s with the pool TypeError before constructing any PGlite', async (max) => {
    const { bridgeModule, pgliteCtor } = await importBridgeWithPGliteSpy();
    let constructed: InstanceType<BridgeModule['PGliteBridge']> | undefined;
    try {
      let caught: unknown;
      try {
        constructed = new bridgeModule.PGliteBridge({ max });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect((caught as TypeError).message).toBe(
        `PgBridgePool: max must be a positive integer (got ${String(max)})`,
      );
      // The load-bearing ordering pin: the constructor's own comment says
      // "Validate before any PGlite is created" — an invalid max must be
      // rejected before `new PGlite()` runs, not by the pool afterwards.
      expect(pgliteCtor).not.toHaveBeenCalled();
    } finally {
      // Safety net: if the guard ever regresses to not throwing at all,
      // don't leak the constructed (mocked) bridge into later tests.
      await constructed?.close();
    }
  });

  it('accepts a valid max — the guard does not over-reject', async () => {
    const { bridgeModule, pgliteCtor } = await importBridgeWithPGliteSpy();
    const bridge = new bridgeModule.PGliteBridge({ max: 2 });
    try {
      expect(pgliteCtor).toHaveBeenCalledTimes(1);
      expect(bridge.adapter).toBeDefined();
    } finally {
      await bridge.close();
    }
  });
});

describe('assertPoolMax — pool module export', () => {
  it('exports a function from src/pool enforcing the positive-integer max contract', async () => {
    // Dynamic import + cast through unknown: pre-fix the export does not
    // exist, and a static named import would turn the missing export into a
    // compile failure for this whole file instead of one red test.
    const poolModule: unknown = await import('../pool/index.ts');
    const { assertPoolMax } = poolModule as { assertPoolMax?: unknown };
    expect(assertPoolMax).toBeTypeOf('function');

    const guard = assertPoolMax as (max: number) => void;
    expect(() => guard(3)).not.toThrow();

    let caught: unknown;
    try {
      guard(0);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect((caught as TypeError).message).toBe(
      'PgBridgePool: max must be a positive integer (got 0)',
    );
  });

  it('is not re-exported from the package entry', async () => {
    // Internal-only seam: src/index.ts keeps its curated named exports.
    const entry: object = await import('../index.ts');
    expect('PGliteBridge' in entry).toBe(true);
    expect('assertPoolMax' in entry).toBe(false);
  });
});
