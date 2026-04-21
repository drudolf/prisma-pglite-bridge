import { describe, expect, it } from 'vitest';

import setupPGlite from './__tests__/pglite.ts';
import { createPool } from './create-pool.ts';

const pglite = await setupPGlite();

describe('createPool — adapterId', async () => {
  it('returns a symbol, unique per call when omitted', async () => {
    const a = await createPool({ pglite });
    const b = await createPool({ pglite });
    try {
      expect(typeof a.adapterId).toBe('symbol');
      expect(typeof b.adapterId).toBe('symbol');
      expect(a.adapterId).not.toBe(b.adapterId);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('honors the adapterId passed in options', async () => {
    const adapterId = Symbol('custom');
    const pool = await createPool({ pglite, adapterId });
    try {
      expect(pool.adapterId).toBe(adapterId);
    } finally {
      await pool.close();
    }
  });
});

describe('createPool — max default', () => {
  it(`defaults max to 1 when the option is omitted`, async () => {
    const { pool, close } = await createPool({ pglite });
    try {
      expect(pool.options.max).toBe(1);
    } finally {
      await close();
    }
  });

  it('honors an explicit max override', async () => {
    const { pool, close } = await createPool({ pglite, max: 3 });
    try {
      expect(pool.options.max).toBe(3);
    } finally {
      await close();
    }
  });
});
