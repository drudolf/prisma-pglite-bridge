import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from './__tests__/file-system.ts';
import setupPGlite from './__tests__/pglite.ts';
import PgBridgePool from './pool.ts';

const pglite = await setupPGlite();

describe('PgBridgePool — bridgeId', async () => {
  it('returns a symbol, unique per call when omitted', async () => {
    const a = new PgBridgePool({ pglite });
    const b = new PgBridgePool({ pglite });
    try {
      expect(typeof a.bridgeId).toBe('symbol');
      expect(typeof b.bridgeId).toBe('symbol');
      expect(a.bridgeId).not.toBe(b.bridgeId);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it('honors the bridgeId passed in options', async () => {
    const bridgeId = Symbol('custom');
    const pool = new PgBridgePool({ pglite, bridgeId });
    try {
      expect(pool.bridgeId).toBe(bridgeId);
    } finally {
      await pool.end();
    }
  });
});

describe('PgBridgePool — max default', () => {
  it(`defaults max to 1 when the option is omitted`, async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      expect(pool.options.max).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('honors an explicit max override', async () => {
    const pool = new PgBridgePool({ pglite, max: 3 });
    try {
      expect(pool.options.max).toBe(3);
    } finally {
      await pool.end();
    }
  });
});

describe('PgBridgePool — syncToFs', () => {
  it('defaults to false for in-memory PGlite', async () => {
    const seen: boolean[] = [];
    const original = pglite.execProtocolRawStream.bind(pglite);
    pglite.execProtocolRawStream = (async (message, options) => {
      seen.push(options.syncToFs ?? true);
      return original(message, options);
    }) as typeof pglite.execProtocolRawStream;

    const pool = new PgBridgePool({ pglite });
    try {
      await pool.query('SELECT 1');
      expect(seen).toContain(false);
    } finally {
      pglite.execProtocolRawStream = original;
      await pool.end();
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

    const pool = new PgBridgePool({ pglite: persistent });
    try {
      await pool.query('SELECT 1');
      expect(seen).toContain(true);
    } finally {
      persistent.execProtocolRawStream = original;
      await pool.end();
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

    const pool = new PgBridgePool({ pglite: persistent, syncToFs: false });
    try {
      await pool.query('SELECT 1');
      expect(seen).toContain(false);
    } finally {
      persistent.execProtocolRawStream = original;
      await pool.end();
      await persistent.close();
      removeTempDir(parent);
    }
  });
});

describe('PgBridgePool — rollback on forced client release', () => {
  it('rolls back uncommitted state when a max=1 client is destroyed mid-transaction', async () => {
    // max=1 → no SessionLock. Rollback must still run on destroy, otherwise
    // PGlite is left in 'T' state and the next connection inherits it.
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const c1 = await pool.connect();
      await c1.query('CREATE TABLE rollback_t (id int)');
      await c1.query('BEGIN');
      await c1.query('INSERT INTO rollback_t VALUES (1)');
      // release(true) → pg.Pool destroys the underlying PgBridgeClient/duplex
      // without sending Terminate. Cleanup must come from PGliteDuplex._destroy.
      c1.release(new Error('forced release'));

      const c2 = await pool.connect();
      try {
        const r = await c2.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM rollback_t',
        );
        expect(r.rows[0]?.count).toBe('0');
      } finally {
        c2.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });
});

// The framer rewrites RowDescription `oid 18` ("char") → `oid 25` (text) only
// when the field originates from a pg_catalog relation. User-defined "char"
// columns are intentionally left untouched: the bridge must not relabel a
// 1-byte type as text on user data.
//
// Note: PGlite's text-mode wire encoding escapes non-ASCII "char" bytes (e.g.
// byte 0xC3 → "\303") before the framer ever sees them. That fidelity loss is
// upstream and cannot be repaired by the bridge. The assertion below pins what
// scoping IS responsible for — that bridged queries on user "char" data
// behave the same as querying PGlite directly.
describe('PgBridgePool — "char" oid 18 parity on user tables', () => {
  it('matches native PGlite output for a non-ASCII byte in a user "char" column', async () => {
    const local = new PGlite();
    await local.waitReady;
    await local.exec('CREATE TABLE t (c "char")');
    await local.exec(`INSERT INTO t (c) VALUES (chr(200)::"char")`);

    const native = await local.query<{ c: string }>('SELECT c FROM t');
    const nativeValue = native.rows[0]?.c;
    expect(nativeValue).toBeDefined();

    const pool = new PgBridgePool({ pglite: local });
    try {
      const bridged = await pool.query<{ c: string }>('SELECT c FROM t');
      const bridgedValue = bridged.rows[0]?.c;
      // Parity: the bridge does not corrupt or alter user "char" output beyond
      // what PGlite already produces natively.
      expect(bridgedValue).toBe(nativeValue);
    } finally {
      await pool.end();
      await local.close();
    }
  });
});
