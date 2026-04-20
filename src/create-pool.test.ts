import { describe, expect, it } from 'vitest';
import { setupPGlite } from './__tests__/pglite.ts';
import { createPool } from './create-pool.ts';

const getPGlite = setupPGlite();

describe('createPool — adapterId', () => {
  it('returns a symbol, unique per call when omitted', async () => {
    const pglite = getPGlite();
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
    const id = Symbol('custom');
    const pool = await createPool({ pglite: getPGlite(), adapterId: id });
    try {
      expect(pool.adapterId).toBe(id);
    } finally {
      await pool.close();
    }
  });
});

describe('createPool — wasmInitMs', () => {
  it('is a finite non-negative number when createPool constructs PGlite', async () => {
    const pool = await createPool();
    try {
      expect(typeof pool.wasmInitMs).toBe('number');
      expect(Number.isFinite(pool.wasmInitMs)).toBe(true);
      expect(pool.wasmInitMs).toBeGreaterThanOrEqual(0);
    } finally {
      await pool.close();
    }
  });

  it('is undefined when the caller supplies options.pglite', async () => {
    const pool = await createPool({ pglite: getPGlite() });
    try {
      expect(pool.wasmInitMs).toBeUndefined();
    } finally {
      await pool.close();
    }
  });
});
