import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { createPool } from './create-pool.ts';

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
describe('"char" oid 18 — user-table fields are not relabelled to text', () => {
  it('matches native PGlite output for a non-ASCII byte in a user "char" column', async () => {
    const pglite = new PGlite();
    await pglite.waitReady;
    await pglite.exec('CREATE TABLE t (c "char")');
    await pglite.exec(`INSERT INTO t (c) VALUES (chr(200)::"char")`);

    const native = await pglite.query<{ c: string }>('SELECT c FROM t');
    const nativeValue = native.rows[0]?.c;
    expect(nativeValue).toBeDefined();

    const { pool, close } = await createPool({ pglite });
    try {
      const bridged = await pool.query<{ c: string }>('SELECT c FROM t');
      const bridgedValue = bridged.rows[0]?.c;
      // Parity: the bridge does not corrupt or alter user "char" output beyond
      // what PGlite already produces natively.
      expect(bridgedValue).toBe(nativeValue);
    } finally {
      await close();
      await pglite.close();
    }
  });
});
