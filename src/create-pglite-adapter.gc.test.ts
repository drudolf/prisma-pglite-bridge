import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { createPgliteAdapter } from './create-pglite-adapter.ts';

describe('createPgliteAdapter leak detection', () => {
  it('does not emit a leak warning while the pool is still reachable via the adapter', async () => {
    const gc = (globalThis as { gc?: () => void }).gc;
    if (typeof gc !== 'function') {
      throw new Error('This test requires --expose-gc via the Vitest gc project.');
    }

    const warnSpy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const livePglite = new PGlite();
    let closeAdapter: (() => Promise<void>) | undefined;
    try {
      let adapterRef: unknown;
      await (async () => {
        const result = await createPgliteAdapter({ pglite: livePglite, sql: 'SELECT 1' });
        adapterRef = result.adapter;
        closeAdapter = result.close;
      })();

      for (let i = 0; i < 20; i++) {
        gc();
        await new Promise((resolve) => setImmediate(resolve));
      }

      const leakWarnings = warnSpy.mock.calls.filter(
        ([, opts]) => (opts as { type?: string } | undefined)?.type === 'PgliteAdapterLeakWarning',
      );
      expect(leakWarnings).toEqual([]);
      expect(adapterRef).toBeDefined();
    } finally {
      await closeAdapter?.();
      warnSpy.mockRestore();
      await livePglite.close();
    }
  });
});
