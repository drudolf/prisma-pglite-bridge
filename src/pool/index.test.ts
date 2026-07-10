import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { createTempDir, removeTempDir } from '../__tests__/file-system.ts';
import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgePool } from './index.ts';

const pglite = await setupPGlite();

type ExecProtocolSpy = MockInstance<PGlite['execProtocolRawStream']>;

const seenSyncToFs = (spy: ExecProtocolSpy): boolean[] =>
  spy.mock.calls.map(([, options]) => options?.syncToFs ?? true);

describe('PgBridgePool — bridgeId', async () => {
  it('returns a symbol, unique per call when omitted', async () => {
    // Sequential pools — two live pools on one PGlite would (correctly)
    // emit PGliteBridgeSharedInstanceWarning, and uniqueness doesn't need
    // them alive at the same time.
    const a = new PgBridgePool({ pglite });
    await a.end();
    const b = new PgBridgePool({ pglite });
    try {
      expect(typeof a.bridgeId).toBe('symbol');
      expect(typeof b.bridgeId).toBe('symbol');
      expect(a.bridgeId).not.toBe(b.bridgeId);
    } finally {
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

describe('PgBridgePool — idleTimeoutMillis default', () => {
  it('defaults idleTimeoutMillis to 0 when the option is omitted', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      expect(pool.options.idleTimeoutMillis).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('honors an explicit idleTimeoutMillis override', async () => {
    const pool = new PgBridgePool({ pglite, idleTimeoutMillis: 5000 });
    try {
      expect(pool.options.idleTimeoutMillis).toBe(5000);
    } finally {
      await pool.end();
    }
  });
});

describe('PgBridgePool — syncToFs', () => {
  it('defaults to false for in-memory PGlite', async () => {
    const spy = vi.spyOn(pglite, 'execProtocolRawStream');
    const pool = new PgBridgePool({ pglite });
    try {
      await pool.query('SELECT 1');
      expect(seenSyncToFs(spy)).toContain(false);
    } finally {
      await pool.end();
    }
  });

  it('defaults to true for persistent dataDir instances', async () => {
    const { parent, path: dataDir } = createTempDir('pool-data');
    const persistent = new PGlite(dataDir);
    const spy = vi.spyOn(persistent, 'execProtocolRawStream');

    const pool = new PgBridgePool({ pglite: persistent });
    try {
      await pool.query('SELECT 1');
      expect(seenSyncToFs(spy)).toContain(true);
    } finally {
      await pool.end();
      await persistent.close();
      removeTempDir(parent);
    }
  });

  it('honors an explicit false override for persistent instances', async () => {
    const { parent, path: dataDir } = createTempDir('pool-data-override');
    const persistent = new PGlite(dataDir);
    const spy = vi.spyOn(persistent, 'execProtocolRawStream');

    const pool = new PgBridgePool({ pglite: persistent, syncToFs: false });
    try {
      await pool.query('SELECT 1');
      expect(seenSyncToFs(spy)).toContain(false);
    } finally {
      await pool.end();
      await persistent.close();
      removeTempDir(parent);
    }
  });
});

describe('PgBridgePool — connect-time statement cleanup', () => {
  it('swallows DEALLOCATE failures on connect (best-effort cleanup)', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const query = vi.fn().mockRejectedValue(new Error('session gone'));
      // Emit the pool's own 'connect' event with a client whose cleanup
      // query rejects — the listener must swallow it (a broken session
      // surfaces on real queries instead).
      pool.emit('connect', { query } as never);
      await new Promise((resolve) => setImmediate(resolve));
      expect(query).toHaveBeenCalledWith('DEALLOCATE ALL');
    } finally {
      await pool.end();
    }
  });
});

describe('PgBridgePool — pglite lifecycle', () => {
  it('end() closes the internally-created PGlite (pool owns it)', async () => {
    const pool = new PgBridgePool();
    await pool.end();
    expect(pool.pglite.closed).toBe(true);
  });

  it('end(callback) closes the internally-created PGlite before invoking the callback', async () => {
    const pool = new PgBridgePool();
    const closedAtCallback = await new Promise<boolean>((resolve) => {
      pool.end(() => resolve(pool.pglite.closed));
    });
    expect(closedAtCallback).toBe(true);
  });

  it('end() leaves a caller-supplied PGlite open (caller owns it)', async () => {
    const local = new PGlite();
    await local.waitReady;
    const pool = new PgBridgePool({ pglite: local });
    try {
      await pool.end();
      expect(local.closed).toBe(false);
    } finally {
      await local.close();
    }
  });
});

describe('PgBridgePool — shared-PGlite warning', () => {
  // process.emitWarning delivers the 'warning' event on a later tick, so
  // callers capture into an array and await a setImmediate before asserting.
  const captureSharedWarnings = (): { warnings: Error[]; stop: () => void } => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      if (warning.name === 'PGliteBridgeSharedInstanceWarning') warnings.push(warning);
    };
    process.on('warning', onWarning);
    return {
      warnings,
      stop: () => {
        process.removeListener('warning', onWarning);
      },
    };
  };

  it('warns when a second pool is constructed on a PGlite still used by a live pool', async () => {
    const local = new PGlite();
    await local.waitReady;
    const { warnings, stop } = captureSharedWarnings();
    const first = new PgBridgePool({ pglite: local });
    let second: PgBridgePool | undefined;
    try {
      second = new PgBridgePool({ pglite: local });
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]?.message).toMatch(/prepared statement/i);
    } finally {
      stop();
      await second?.end();
      await first.end();
      await local.close();
    }
  });

  it('does not warn for two pools on two different PGlite instances', async () => {
    const localA = new PGlite();
    const localB = new PGlite();
    await Promise.all([localA.waitReady, localB.waitReady]);
    const { warnings, stop } = captureSharedWarnings();
    const poolA = new PgBridgePool({ pglite: localA });
    const poolB = new PgBridgePool({ pglite: localB });
    try {
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnings).toHaveLength(0);
    } finally {
      stop();
      await poolA.end();
      await poolB.end();
      await localA.close();
      await localB.close();
    }
  });

  it('does not warn for sequential reuse — first pool ended before the second starts', async () => {
    const local = new PGlite();
    await local.waitReady;
    const { warnings, stop } = captureSharedWarnings();
    try {
      const first = new PgBridgePool({ pglite: local });
      await first.end();

      const second = new PgBridgePool({ pglite: local });
      try {
        await new Promise((resolve) => setImmediate(resolve));

        expect(warnings).toHaveLength(0);
      } finally {
        await second.end();
      }
    } finally {
      stop();
      await local.close();
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

// Red-phase TDD spec for the FastQuery fast path in PgBridgeClient.
//
// `fastQueryPath` (default `true`) does not exist on PgBridgePoolOptions
// yet — the type errors and the failing describe-skip / plain-object
// assertions below are the expected red until the fast path lands. The
// fast path activates only for the exact shape @prisma/adapter-pg emits
// when statement caching names a query: non-empty `name`, string `text`,
// `rowMode: 'array'`, a `types.getTypeParser` function, values undefined
// or an Array, and none of binary/rows/portal/queryMode/callback/
// Submittable. Everything else stays on the stock pg path.
describe('PgBridgePool — fastQueryPath', () => {
  // Fast-shape query, adapter-pg style.
  const fastShapeQuery = () => ({
    name: 'fastq_shape',
    text: 'SELECT $1::int AS n',
    values: [7],
    rowMode: 'array' as const,
    types: pg.types,
  });

  it('skips Describe on the warm execution of a named array-mode query', async () => {
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        describeSpy.mockClear();
        const first = await client.query(fastShapeQuery());
        const second = await client.query(fastShapeQuery());

        expect(first.rows).toEqual([[7]]);
        expect(second.rows).toEqual([[7]]);
        // Cold execution describes once; the warm execution reuses the
        // cached fields and must not describe again.
        expect(describeSpy).toHaveBeenCalledTimes(1);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('describes on every execution when fastQueryPath is disabled', async () => {
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite, fastQueryPath: false });
    try {
      const client = await pool.connect();
      try {
        describeSpy.mockClear();
        const first = await client.query(fastShapeQuery());
        const second = await client.query(fastShapeQuery());

        expect(first.rows).toEqual([[7]]);
        expect(second.rows).toEqual([[7]]);
        expect(describeSpy).toHaveBeenCalledTimes(2);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('returns a plain result object on the fast path, not a pg Result', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const result = await pool.query(fastShapeQuery());

      expect(result.constructor.name).not.toBe('Result');
      expect('rowAsArray' in result).toBe(false);
      // Exactly the FastQueryResult shape — no pg.Result internals.
      expect(result).toEqual({
        rows: [[7]],
        fields: [expect.objectContaining({ name: 'n', dataTypeID: 23 })],
        rowCount: 1,
        command: 'SELECT',
        oid: null,
      });
    } finally {
      await pool.end();
    }
  });

  it('returns a stock pg Result when fastQueryPath is disabled', async () => {
    const pool = new PgBridgePool({ pglite, fastQueryPath: false });
    try {
      const result = await pool.query(fastShapeQuery());

      expect(result.constructor.name).toBe('Result');
      expect('rowAsArray' in result).toBe(true);
      expect(result.rows).toEqual([[7]]);
    } finally {
      await pool.end();
    }
  });

  it('routes unnamed queries through the stock path (describe on every execution)', async () => {
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        describeSpy.mockClear();
        // No `name` → stock path even on a default (fast-path-enabled) pool.
        const unnamed = {
          text: 'SELECT $1::int AS n',
          values: [7],
          rowMode: 'array' as const,
          types: pg.types,
        };
        const first = await client.query(unnamed);
        const second = await client.query(unnamed);

        expect(describeSpy).toHaveBeenCalledTimes(2);
        expect(first.constructor.name).toBe('Result');
        expect(second.constructor.name).toBe('Result');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('keeps an unawaited stock query and a fast-shape query ordered on one client', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // Object-form stock query (no name/rowMode → stock path) followed
        // WITHOUT awaiting by a fast-shape query: the client's submission
        // chain must keep mixed-path queries ordered — both resolve.
        const stockPromise = client.query({ text: 'SELECT 1 AS one' });
        const fastPromise = client.query(fastShapeQuery());

        const [stockResult, fastResult] = await Promise.all([stockPromise, fastPromise]);
        expect(stockResult.rows).toEqual([{ one: 1 }]);
        expect(fastResult.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  describe('activation predicate — every rejected leg runs the stock path', () => {
    const isStockResult = (result: unknown): boolean =>
      (result as { constructor: { name: string } }).constructor.name === 'Result';

    it('accepts positional values (two-argument form) on the fast path', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          const { name: _ignored, ...cfg } = fastShapeQuery();
          const result = await client.query(
            { ...cfg, name: 'fq_positional', values: undefined },
            [7],
          );
          expect(isStockResult(result)).toBe(false);
          expect(result.rows).toEqual([[7]]);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });

    it('rejects a third non-callback argument', async () => {
      // Must go through client.query directly — pool.query wraps the promise
      // in a callback, collapsing the argument list before the predicate.
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          const result = await (
            client.query as unknown as (a: unknown, b: unknown, c: unknown) => Promise<unknown>
          )({ ...fastShapeQuery(), name: 'fq_threearg' }, [7], undefined);
          expect(isStockResult(result)).toBe(true);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });

    it('rejects an empty statement name', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const result = await pool.query({ ...fastShapeQuery(), name: '' });
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rejects a name-only re-execution (no text — a legitimate stock pattern)', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const client = await pool.connect();
        try {
          // Prepare via the fast path, then re-execute by name alone.
          const prepared = await client.query({ ...fastShapeQuery(), name: 'fq_reuse' });
          expect(isStockResult(prepared)).toBe(false);

          const reused = await client.query({
            name: 'fq_reuse',
            values: [7],
            rowMode: 'array' as const,
            types: pg.types,
          } as never);
          expect(isStockResult(reused)).toBe(true);
          expect((reused as { rows: unknown[] }).rows).toEqual([[7]]);
        } finally {
          client.release();
        }
      } finally {
        await pool.end();
      }
    });

    it('rejects a missing rowMode', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const { rowMode: _ignored, ...cfg } = fastShapeQuery();
        const result = await pool.query({ ...cfg, name: 'fq_norowmode' } as never);
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rejects non-array values (stock pg then reports its own error)', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        await expect(
          pool.query({ ...fastShapeQuery(), name: 'fq_badvalues', values: 'nope' } as never),
        ).rejects.toThrow(/Query values must be an array/);
      } finally {
        await pool.end();
      }
    });

    it('rejects a missing types object', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        const { types: _ignored, ...cfg } = fastShapeQuery();
        const result = await pool.query({ ...cfg, name: 'fq_notypes' } as never);
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });

    it('rejects stock-pg disqualifiers such as an explicit queryMode', async () => {
      // `rows` (a row limit) would be the other natural disqualifier to
      // exercise, but stock pg drives row-limited queries with Flush, which
      // the duplex EQP-buffers until Sync — a pre-existing bridge
      // limitation independent of the fast path.
      const pool = new PgBridgePool({ pglite });
      try {
        const result = await pool.query({
          ...fastShapeQuery(),
          name: 'fq_qmode',
          queryMode: 'extended',
        } as never);
        expect(isStockResult(result)).toBe(true);
      } finally {
        await pool.end();
      }
    });
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
