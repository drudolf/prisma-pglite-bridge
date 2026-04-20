import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createPool } from './create-pool.ts';

describe('createPool — adapterId', () => {
  it('returns a symbol, unique per call when omitted', async () => {
    const a = await createPool();
    const b = await createPool();
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
    const pool = await createPool({ adapterId: id });
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
    const pglite = new PGlite();
    await pglite.waitReady;
    const pool = await createPool({ pglite });
    try {
      expect(pool.wasmInitMs).toBeUndefined();
    } finally {
      await pool.close();
      await pglite.close();
    }
  });
});
