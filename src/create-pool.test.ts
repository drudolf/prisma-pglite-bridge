import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from './__tests__/file-system.ts';
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

describe('createPool — syncToFs', () => {
  it('defaults to false for in-memory PGlite', async () => {
    const seen: boolean[] = [];
    const original = pglite.execProtocolRawStream.bind(pglite);
    pglite.execProtocolRawStream = (async (message, options) => {
      seen.push(options.syncToFs ?? true);
      return original(message, options);
    }) as typeof pglite.execProtocolRawStream;

    const { pool, close } = await createPool({ pglite });
    try {
      await pool.query('SELECT 1');
      expect(seen).toContain(false);
    } finally {
      pglite.execProtocolRawStream = original;
      await close();
    }
  });

  it('defaults to true for persistent dataDir instances', async () => {
    const { parent, path: dataDir } = createTempDir('pool-data');
    const persistent = new PGlite(dataDir);
    const seen: boolean[] = [];
    const original = persistent.execProtocolRawStream.bind(persistent);
    persistent.execProtocolRawStream = (async (message, options) => {
      seen.push(options.syncToFs ?? true);
      return original(message, options);
    }) as typeof persistent.execProtocolRawStream;

    const { pool, close } = await createPool({ pglite: persistent });
    try {
      await pool.query('SELECT 1');
      expect(seen).toContain(true);
    } finally {
      persistent.execProtocolRawStream = original;
      await close();
      await persistent.close();
      removeTempDir(parent);
    }
  });

  it('honors an explicit false override for persistent instances', async () => {
    const { parent, path: dataDir } = createTempDir('pool-data-override');
    const persistent = new PGlite(dataDir);
    const seen: boolean[] = [];
    const original = persistent.execProtocolRawStream.bind(persistent);
    persistent.execProtocolRawStream = (async (message, options) => {
      seen.push(options.syncToFs ?? true);
      return original(message, options);
    }) as typeof persistent.execProtocolRawStream;

    const { pool, close } = await createPool({ pglite: persistent, syncToFs: false });
    try {
      await pool.query('SELECT 1');
      expect(seen).toContain(false);
    } finally {
      persistent.execProtocolRawStream = original;
      await close();
      await persistent.close();
      removeTempDir(parent);
    }
  });
});
