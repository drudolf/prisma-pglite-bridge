import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { createPGliteBridge } from './pglite-bridge.ts';

describe('createPGliteBridge leak detection', () => {
  it('does not emit a leak warning while the pool is still reachable via the adapter', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') {
      throw new Error('This test requires --expose-gc via the Vitest gc project.');
    }

    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const livePGlite = new PGlite();
    let closeBridge: (() => Promise<void>) | undefined;
    try {
      let adapterRef: unknown;
      await (async () => {
        const result = await createPGliteBridge({ pglite: livePGlite });
        adapterRef = result.adapter;
        closeBridge = result.close;
      })();

      for (let i = 0; i < 20; i++) {
        gc();
        await new Promise((resolve) => setImmediate(resolve));
      }

      const leakWarnings = warnSpy.mock.calls.filter(
        ([, opts]) => (opts as { type?: string } | undefined)?.type === 'PGliteBridgeLeakWarning',
      );
      expect(leakWarnings).toEqual([]);
      expect(adapterRef).toBeDefined();
    } finally {
      await closeBridge?.();
      warnSpy.mockRestore();
      await livePGlite.close();
    }
  });
});
