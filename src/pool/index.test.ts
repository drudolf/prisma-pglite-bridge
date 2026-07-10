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
      // Balance the liveClientCounts increment from the synthetic 'connect' above;
      // without this a subsequent real connect on the same PGlite would see
      // prevClientCount > 0 and skip DEALLOCATE ALL, breaking test isolation.
      // The 'remove' listener also runs the belt-and-suspenders live-client
      // registry deregistration (ADR 002) — stub it on the synthetic client.
      pool.emit('remove', { deregisterLiveClient: () => {} } as never);
    } finally {
      await pool.end();
    }
  });

  it("creating a second pool client leaves the first client's prepared statements intact", async () => {
    // PGlite is one shared session, so a sibling's connect-time
    // DEALLOCATE ALL would destroy client A's live named statements —
    // A's next named execution would fail with Postgres error 26000.
    // With another live client in the pool, the cleanup must be skipped.
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      const cold = await a.query({ name: 'wave2_s1', text: 'SELECT 41 AS x' });
      expect(cold.rows).toEqual([{ x: 41 }]);

      // A is still checked out, so this forces creation of a second client;
      // its first query guarantees any connect-time cleanup has completed
      // (pg serializes queries per client).
      b = await pool.connect();
      await b.query('SELECT 1');

      const warm = await a.query({ name: 'wave2_s1', text: 'SELECT 41 AS x' });
      expect(warm.rows).toEqual([{ x: 41 }]);
    } finally {
      a?.release();
      b?.release();
      await pool.end();
      await local.close();
    }
  });

  it('a replacement client created after a destroy still gets the cleanup', async () => {
    // Sole-client path: pg.Pool removed the destroyed client, but PGlite's
    // shared session still holds its server-side prepared statement. The
    // replacement must see an empty statement namespace — without the
    // connect-time DEALLOCATE ALL, re-preparing the same name would fail
    // with 42P05 "prepared statement already exists".
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local, max: 1 });
    try {
      const a = await pool.connect();
      await a.query({ name: 'wave2_s2', text: 'SELECT 1' });
      // release(err) → pg.Pool destroys the client instead of pooling it.
      a.release(new Error('force destroy'));

      const b = await pool.connect();
      try {
        const r = await b.query({ name: 'wave2_s2', text: 'SELECT 1' });
        expect(r.rows).toEqual([{ '?column?': 1 }]);
      } finally {
        b.release();
      }
    } finally {
      await pool.end();
      await local.close();
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
      const message = warnings[0]?.message ?? '';
      // The warning still advises about WASM-mutex serialization and
      // cross-pool transaction interleaving — but no longer claims caching
      // is suspended (per-client names keep caching active during overlap).
      expect(message).toMatch(/WASM mutex/i);
      expect(message).toMatch(/interleave/i);
      expect(message).not.toMatch(/caching/i);
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

  it('releases the live slot exactly once across a double end() — a later pool pair still warns', async () => {
    // Pins the #releaseLiveSlot guard end-to-end. end() decrements the
    // shared-instance counter synchronously BEFORE pg-pool rejects a
    // repeated end(), so without the guard pool A's second end() would
    // drive the count to -1: pool B would then land on 0, pool C on 1, and
    // the legitimate shared-instance warning below would never fire.
    // Fresh PGlite instance so no other test's counts bleed in (condition).
    const local = new PGlite();
    await local.waitReady;
    const { warnings, stop } = captureSharedWarnings();
    let b: PgBridgePool | undefined;
    let c: PgBridgePool | undefined;
    try {
      const a = new PgBridgePool({ pglite: local }); // count → 1
      await a.end(); // count → 0
      // pg-pool rejects the repeated end(); the guard must keep the count
      // at 0 instead of double-decrementing.
      await expect(a.end()).rejects.toThrow();

      b = new PgBridgePool({ pglite: local }); // count → 1, no warning
      c = new PgBridgePool({ pglite: local }); // count → 2 → warning
      // process.emitWarning delivers async — flush before asserting.
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message ?? '').toMatch(/WASM mutex/i);
    } finally {
      stop();
      await b?.end();
      await c?.end();
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

  it('injects a name into unnamed DML and routes it through the fast path', async () => {
    const describeSpy = vi.spyOn(pg.Connection.prototype, 'describe');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        describeSpy.mockClear();
        // No `name` on a statementCaching pool → name injected → fast path for
        // queries that also carry rowMode:'array' + types. First call sends Describe
        // to populate #fieldsCache; second call skips it (cache hit).
        const unnamed = {
          text: 'SELECT $1::int AS n',
          values: [7],
          rowMode: 'array' as const,
          types: pg.types,
        };
        const first = await client.query(unnamed);
        const second = await client.query(unnamed);

        expect(describeSpy).toHaveBeenCalledTimes(1);
        expect(first.rows).toEqual([[7]]);
        expect(second.rows).toEqual([[7]]);
        expect(first.constructor.name).not.toBe('Result');
        expect(second.constructor.name).not.toBe('Result');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('re-sends Parse after DEALLOCATE ALL and succeeds (guards parsedStatements coupling)', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        // Cold execution — Parse is sent, statement lands in parsedStatements.
        await client.query(fastShapeQuery());
        parseSpy.mockClear();

        // Warm execution — pg skips Parse (parsedStatements guard).
        await client.query(fastShapeQuery());
        expect(parseSpy).not.toHaveBeenCalled();

        // Invalidate PGlite's copy of all named statements.
        await client.query('DEALLOCATE ALL');
        parseSpy.mockClear();

        // Next execution must re-Parse. If #clearStatementCaches failed to
        // evict from pg's parsedStatements (e.g. due to a pg internal rename),
        // pg would skip Parse and PGlite would return error 26000.
        const result = await client.query(fastShapeQuery());
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('re-sends Parse only for the named statement after DEALLOCATE <name>', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const other = { ...fastShapeQuery(), name: 'fastq_keep' };
        // Prepare both statements, then warm them so Parse is skipped.
        await client.query(fastShapeQuery());
        await client.query(other);
        parseSpy.mockClear();

        // Deallocate one by name: PGlite forgets it, and #clearStatementCaches
        // must evict exactly that entry from parsedStatements/#fieldsCache.
        await client.query(`DEALLOCATE ${fastShapeQuery().name}`);

        // The deallocated statement re-Parses; the untouched one stays warm.
        const rePrepared = await client.query(fastShapeQuery());
        const stillWarm = await client.query(other);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(rePrepared.rows).toEqual([[7]]);
        expect(stillWarm.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('evicts a statement deallocated with different unquoted case (PG identifier folding)', async () => {
    // PostgreSQL folds unquoted identifiers to lowercase, so DEALLOCATE
    // FQ_FOLD deallocates fq_fold server-side. The eviction must fold the
    // captured name the same way, or pg's cache would keep fq_fold and the
    // next execution would skip Parse into a 26000.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const named = { ...fastShapeQuery(), name: 'fq_fold' };
        await client.query(named);

        await client.query('DEALLOCATE FQ_FOLD');

        parseSpy.mockClear();
        const result = await client.query(named);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('evicts a quoted statement name containing non-word characters', async () => {
    // Protocol-level statement names are byte-exact and may contain hyphens;
    // only a quoted identifier can DEALLOCATE them. The detection regex must
    // match the quoted form, or the eviction is skipped entirely and the
    // next execution skips Parse into a 26000.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool({ pglite });
    try {
      const client = await pool.connect();
      try {
        const named = { ...fastShapeQuery(), name: 'fq-hyphen' };
        await client.query(named);

        await client.query('DEALLOCATE "fq-hyphen"');

        parseSpy.mockClear();
        const result = await client.query(named);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([[7]]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('cache survives a transient sibling — zero Parse after a sibling pool joins and leaves', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const poolA = new PgBridgePool({ pglite: local });

    // Swallow the expected shared-instance warning emitted when poolB joins.
    const swallowSharedWarning = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallowSharedWarning);

    try {
      // Warm pool A — its client Parses the SQL once under its own
      // client-unique name.
      await poolA.query({ text: 'SELECT 7 AS n', values: [] });

      // Sibling joins, queries, and leaves. Per-client names need no
      // coordination: pool B's connect must not fire DEALLOCATE ALL
      // (liveClientCounts was already 1), and its departure must not evict
      // or invalidate pool A's cache — no suspension, no epoch, no re-Parse.
      const poolB = new PgBridgePool({ pglite: local });
      try {
        await poolB.query('SELECT 1');
      } finally {
        await poolB.end();
      }

      parseSpy.mockClear();
      // Pool A's cache stayed warm through the sibling churn: the repeat
      // query sends ZERO Parse and succeeds.
      const result = await poolA.query({ text: 'SELECT 7 AS n', values: [] });
      expect(parseSpy).not.toHaveBeenCalled();
      expect(result.rows).toEqual([{ n: 7 }]);
    } finally {
      process.off('warning', swallowSharedWarning);
      await poolA.end();
      await local.close();
    }
  });

  it('sequential multi-pool: second pool re-Parses cleanly after first pool ends', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const swallow = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallow);
    try {
      // Pool A Parses the SQL under its own client-unique name while it is
      // the sole pool.
      const poolA = new PgBridgePool({ pglite: local });
      try {
        await poolA.query({ text: 'SELECT 9 AS n', values: [] });
      } finally {
        await poolA.end(); // client removed → liveClientCounts 1→0
      }
      parseSpy.mockClear();

      // Pool B starts fresh: connect fires liveClientCounts 0→1 → DEALLOCATE ALL.
      const poolB = new PgBridgePool({ pglite: local });
      try {
        const result = await poolB.query({ text: 'SELECT 9 AS n', values: [] });
        // Fresh Parse under pool B's own name (PGlite was clean after the
        // genuine 0→1 DEALLOCATE ALL on pool B's connect).
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(result.rows).toEqual([{ n: 9 }]);
      } finally {
        await poolB.end();
      }
    } finally {
      process.off('warning', swallow);
      await local.close();
    }
  });

  it('concurrent multi-pool: both pools cache during the overlap under distinct client-unique names', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const swallow = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallow);
    const shape = { text: 'SELECT 11 AS n', values: [] };
    try {
      const poolA = new PgBridgePool({ pglite: local });
      const poolB = new PgBridgePool({ pglite: local });
      try {
        // Cold phase DURING the overlap: each pool's client Parses the same
        // SQL under its own client-unique name — two Parses, no 42P05, no
        // caching suspension.
        parseSpy.mockClear();
        const coldA = await poolA.query(shape);
        const coldB = await poolB.query(shape);
        expect(coldA.rows).toEqual([{ n: 11 }]);
        expect(coldB.rows).toEqual([{ n: 11 }]);
        expect(parseSpy).toHaveBeenCalledTimes(2);

        // Both statements coexist in the shared session under distinct names.
        const { rows } = await local.query<{ name: string }>(
          'SELECT name FROM pg_prepared_statements',
        );
        const names = rows.map((row) => row.name).filter((name) => name.startsWith('ppb_'));
        expect(names).toHaveLength(2);
        expect(new Set(names).size).toBe(2);
        for (const name of names) expect(name).toMatch(/^ppb_\d+_\d+$/);

        // Warm phase: both caches stay active while the pools overlap —
        // zero Parse, no 26000.
        parseSpy.mockClear();
        const warmA = await poolA.query(shape);
        const warmB = await poolB.query(shape);
        expect(warmA.rows).toEqual([{ n: 11 }]);
        expect(warmB.rows).toEqual([{ n: 11 }]);
        expect(parseSpy).not.toHaveBeenCalled();
      } finally {
        await poolA.end();
        await poolB.end();
      }
    } finally {
      process.off('warning', swallow);
      await local.close();
    }
  });

  it('liveClientCounts returns to zero after all pools end (DEALLOCATE ALL fires again)', async () => {
    const local = new PGlite();
    const swallow = (w: Error): void => {
      if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
    };
    process.on('warning', swallow);
    try {
      const poolA = new PgBridgePool({ pglite: local });
      const poolB = new PgBridgePool({ pglite: local });
      // Trigger connects on both pools.
      await poolA.query('SELECT 1');
      await poolB.query('SELECT 1');

      // Both pools end → two 'remove' events → liveClientCounts 2→1→0.
      await poolA.end();
      await poolB.end();

      // A new pool should see liveClientCounts = 0 → DEALLOCATE ALL fires on connect.
      // Verify through a Parse spy: after the cleanup, pool C's client sends
      // a fresh Parse under its own client-unique name.
      const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
      const poolC = new PgBridgePool({ pglite: local });
      try {
        await poolC.query({ text: 'SELECT 13 AS n', values: [] });
        expect(parseSpy).toHaveBeenCalledTimes(1); // fresh Parse after DEALLOCATE ALL
      } finally {
        await poolC.end();
      }
    } finally {
      process.off('warning', swallow);
      await local.close();
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

    it('rejects an empty query text (stock pg owns EmptyQueryResponse semantics)', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        // values: [] — the empty statement takes no parameters, and binding
        // one fails identically on either path, masking the discriminator.
        const result = await pool.query({
          ...fastShapeQuery(),
          name: 'fq_emptytext',
          text: '',
          values: [],
        });
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

// Per-client statement-name scoping (ADR 002): every PgBridgeClient names
// statements in its own process-unique namespace (`ppb_<namespace>_<n>`), so
// bridge-injected Parses can never collide across clients, pools, or client
// generations — no epoch, no suspension, no coordination. Session-wide
// DEALLOCATE/DISCARD through any pool client evicts matching entries from
// EVERY live client's pg parse cache via the live-client registry.
describe('PgBridgePool — per-client statement names', () => {
  const swallowSharedWarning = (w: Error): void => {
    if (w.name === 'PGliteBridgeSharedInstanceWarning') return;
  };

  it('two unawaited queries after a sibling departs stay cached — reusing the first shape succeeds', async () => {
    // Defect 1 regression: the removed #prefixDeallocAll machinery wrapped
    // BOTH queries of one synchronous tick with a DEALLOCATE ALL after a
    // sibling pool departed; the second wipe destroyed the first query's
    // just-Parsed statement, so a third query reusing that shape failed
    // with 26000. Per-client names need no post-departure cleanup at all.
    const local = new PGlite();
    process.on('warning', swallowSharedWarning);
    const poolA = new PgBridgePool({ pglite: local });
    let a: pg.PoolClient | undefined;
    try {
      a = await poolA.connect();
      // Establish the client and its cache before the sibling churn.
      await a.query({ text: 'SELECT 1 AS one', values: [] });

      const poolB = new PgBridgePool({ pglite: local });
      try {
        await poolB.query('SELECT 1');
      } finally {
        await poolB.end();
      }

      // Two queries in one synchronous tick, unawaited — in-contract usage:
      // the submission chain keeps same-client queries ordered.
      const first = a.query({ text: 'SELECT 21 AS x', values: [] });
      const second = a.query({ text: 'SELECT 22 AS y', values: [] });
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult.rows).toEqual([{ x: 21 }]);
      expect(secondResult.rows).toEqual([{ y: 22 }]);

      // Reuse the FIRST query's shape: its cached statement must still exist.
      const third = await a.query({ text: 'SELECT 21 AS x', values: [] });
      expect(third.rows).toEqual([{ x: 21 }]);
    } finally {
      a?.release();
      process.off('warning', swallowSharedWarning);
      await poolA.end();
      await local.close();
    }
  });

  it('DISCARD ALL through the pool evicts the cache — the repeat query re-Parses and succeeds', async () => {
    // Defect 2 regression: DISCARD ALL includes DEALLOCATE-ALL semantics,
    // but the old detection matched only DEALLOCATE — PGlite forgot the
    // statements while pg's parse-skip cache kept them, permanently
    // poisoning the client (every warm shape failed 26000 thereafter).
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        const shape = { text: 'SELECT 32 AS n', values: [] };
        await client.query(shape);
        parseSpy.mockClear();
        await client.query(shape);
        expect(parseSpy).not.toHaveBeenCalled(); // warm — cache active

        await client.query('DISCARD ALL');

        parseSpy.mockClear();
        const result = await client.query(shape);
        expect(parseSpy).toHaveBeenCalledTimes(1); // re-Parse, not skip → 26000
        expect(result.rows).toEqual([{ n: 32 }]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('zombie-client connect race: a successor pool queries the same SQL while the old client is still ending', async () => {
    // Defect 3 regression: pg-pool resolves pool.end()'s promise BEFORE
    // client.end()'s callback fires, so a successor pool's first client can
    // connect while liveClientCounts still counts the zombie — the 0→1
    // DEALLOCATE ALL is skipped. Under the removed shared generator the same
    // SQL mapped to a name PGlite still held → 42P05. Per-client names make
    // the skipped cleanup benign (a bounded leak, not an error). Reproduced
    // deterministically by delaying the dying client's end() by 300 ms.
    const local = new PGlite();
    const poolA = new PgBridgePool({ pglite: local });
    const clients: pg.Client[] = [];
    poolA.on('connect', (client) => {
      clients.push(client as unknown as pg.Client);
    });
    try {
      const shape = { text: 'SELECT 31 AS n', values: [] };
      await poolA.query(shape); // pool A Parses its name into the session

      const dying = clients[0];
      if (dying === undefined) throw new Error('pool A client was not captured');
      // Delay the client's teardown. pg-pool calls client.end(cb) — keep the
      // callback (and promise form) working, just 300 ms later.
      const originalEnd = dying.end.bind(dying) as (...endArgs: unknown[]) => unknown;
      dying.end = ((...endArgs: unknown[]) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            void Promise.resolve(originalEnd(...endArgs)).then(() => resolve());
          }, 300);
        })) as pg.Client['end'];
      const removed = new Promise<void>((resolve) => {
        poolA.once('remove', () => resolve());
      });

      const endP = poolA.end();

      // Successor pool queries the SAME SQL immediately, while the zombie
      // client's delayed end() is still pending.
      const poolB = new PgBridgePool({ pglite: local });
      try {
        const result = await poolB.query(shape);
        expect(result.rows).toEqual([{ n: 31 }]); // no 42P05
      } finally {
        await endP;
        await removed; // zombie fully torn down before PGlite closes
        await poolB.end();
      }
    } finally {
      await local.close();
    }
  });

  it('a racing warm query hit by a concurrent DEALLOCATE ALL fails clean (26000 at worst) and self-heals', async () => {
    // Design test 8 (tribunal-mandated; gates the preparedStatements default
    // flip): client B's warm named query already in flight when client A's
    // DEALLOCATE ALL lands may fail — but only with a clean, transient
    // 26000. Registry eviction runs when the DEALLOCATE resolves, so B's
    // NEXT repeat query re-Parses and succeeds.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      const shape = { text: 'SELECT 51 AS n', values: [] };
      await b.query(shape); // warm B's cache — Parse is skipped from here on

      // Fire the dealloc first, then B's warm query in the same tick, so
      // the DEALLOCATE has the best chance to land before B's Bind.
      const deallocP = a.query('DEALLOCATE ALL');
      const racingSettled = Promise.allSettled([b.query(shape)]);
      await deallocP;
      const [outcome] = await racingSettled;

      if (outcome.status === 'fulfilled') {
        // B's Bind won the race — the query simply succeeds.
        expect(outcome.value.rows).toEqual([{ n: 51 }]);
      } else {
        // The ONLY acceptable failure: a clean 26000 — no corruption, no hang.
        expect((outcome.reason as { code?: string }).code).toBe('26000');
      }

      // Self-healing: eviction already propagated to B, so its next repeat
      // query re-Parses and succeeds.
      parseSpy.mockClear();
      const healed = await b.query(shape);
      expect(parseSpy).toHaveBeenCalledTimes(1);
      expect(healed.rows).toEqual([{ n: 51 }]);
    } finally {
      a?.release();
      b?.release();
      await pool.end();
      await local.close();
    }
  });

  it("evicts a statementCaching: false client's user-named statements on a sibling's DEALLOCATE ALL", async () => {
    // Design test 9 (tribunal-mandated): clients register in the live-client
    // registry regardless of statementCaching — a non-caching client still
    // holds user-named entries in pg's parse-skip cache that must be evicted
    // when a sibling wipes the shared session.
    const local = new PGlite();
    process.on('warning', swallowSharedWarning);
    const nonCaching = new PgBridgePool({ pglite: local, statementCaching: false });
    const caching = new PgBridgePool({ pglite: local });
    let nc: pg.PoolClient | undefined;
    let c: pg.PoolClient | undefined;
    try {
      nc = await nonCaching.connect();
      c = await caching.connect();

      const named = { name: 'user_stmt', text: 'SELECT 61 AS n' };
      const cold = await nc.query(named);
      expect(cold.rows).toEqual([{ n: 61 }]);

      await c.query('DEALLOCATE ALL');

      // Without registry propagation pg would skip Parse for user_stmt and
      // PGlite would answer 26000. Eviction forces a clean re-Parse.
      const repeat = await nc.query(named);
      expect(repeat.rows).toEqual([{ n: 61 }]);
    } finally {
      nc?.release();
      c?.release();
      process.off('warning', swallowSharedWarning);
      await nonCaching.end();
      await caching.end();
      await local.close();
    }
  });

  it('DISCARD ALL under max: 2 evicts both clients — both repeat queries re-Parse and succeed', async () => {
    // Design test 10 (tribunal-mandated): session-wide invalidation reaches
    // every live client of the pool, not only the issuer.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      const shape = { text: 'SELECT 71 AS n', values: [] };
      await a.query(shape);
      await b.query(shape); // both clients warm, distinct names

      await a.query('DISCARD ALL');

      parseSpy.mockClear();
      const repeatA = await a.query(shape);
      const repeatB = await b.query(shape);
      expect(repeatA.rows).toEqual([{ n: 71 }]);
      expect(repeatB.rows).toEqual([{ n: 71 }]);
      // Both clients re-Parsed their own name — the eviction reached the
      // non-issuing client too.
      expect(parseSpy).toHaveBeenCalledTimes(2);
    } finally {
      a?.release();
      b?.release();
      await pool.end();
      await local.close();
    }
  });

  it('max: 2 caching — both clients cache the same SQL under distinct names: 2 cold Parses, 0 warm', async () => {
    // Design test 5: with per-client namespaces, multiple clients in one
    // pool cache the same SQL safely — no 42P05, no silent disable.
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      const shape = { text: 'SELECT 81 AS n', values: [] };

      parseSpy.mockClear();
      const coldA = await a.query(shape);
      const coldB = await b.query(shape);
      expect(coldA.rows).toEqual([{ n: 81 }]);
      expect(coldB.rows).toEqual([{ n: 81 }]);
      expect(parseSpy).toHaveBeenCalledTimes(2);

      // The same SQL landed under two distinct client-unique names.
      const { rows } = await local.query<{ name: string }>(
        'SELECT name FROM pg_prepared_statements',
      );
      const names = rows.map((row) => row.name).filter((name) => name.startsWith('ppb_'));
      expect(names).toHaveLength(2);
      expect(new Set(names).size).toBe(2);
      for (const name of names) expect(name).toMatch(/^ppb_\d+_\d+$/);

      parseSpy.mockClear();
      const warmA = await a.query(shape);
      const warmB = await b.query(shape);
      expect(warmA.rows).toEqual([{ n: 81 }]);
      expect(warmB.rows).toEqual([{ n: 81 }]);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      a?.release();
      b?.release();
      await pool.end();
      await local.close();
    }
  });
});

// String-form parameterized queries — `query(text, values)` with a NON-EMPTY
// values array — get the same per-client statement-name injection as the
// object form when statement caching is on: pg then skips Parse on repeat
// executions via its parsedStatements guard. The rest of the string-form
// dispatch is deliberately untouched: `query(text)` and `query(text, [])`
// stay unnamed on the simple protocol, non-cacheable text is never named,
// and a statementCaching: false pool sees no normalization at all.
describe('PgBridgePool — string-form parameterized statement caching', () => {
  // Session-side proof of naming: injected names show up in
  // pg_prepared_statements on the same client. The introspection query
  // itself is string-form WITHOUT values, so it never appears in the list.
  const listBridgeStatements = async (client: pg.PoolClient): Promise<string[]> => {
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM pg_prepared_statements WHERE name LIKE 'ppb_%'",
    );
    return rows.map((row) => row.name);
  };

  it('caches string-form parameterized DML and skips Parse on the warm execution', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        parseSpy.mockClear();
        const cold = await client.query('SELECT $1::int AS n', [7]);
        const warm = await client.query('SELECT $1::int AS n', [7]);

        expect(cold.rows).toEqual([{ n: 7 }]);
        expect(warm.rows).toEqual([{ n: 7 }]);
        // One Parse total across both executions: the cold call named and
        // parsed the statement, the warm call skipped Parse via pg's
        // parsedStatements guard — a cached plan, not a re-preparation.
        expect(parseSpy).toHaveBeenCalledTimes(1);

        // The statement is cached under a bridge-injected name.
        const names = await listBridgeStatements(client);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^ppb_\d+_\d+$/);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('reuses one cached statement across the string form and the object form', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        parseSpy.mockClear();
        // Same text, fresh values array per call: the name generator keys on
        // the SQL text, so both forms must map to ONE statement name — one
        // Parse total, and the second form rides the first form's cache.
        const viaString = await client.query('SELECT $1::int AS n', [8]);
        const viaObject = await client.query({ text: 'SELECT $1::int AS n', values: [8] });

        expect(viaString.rows).toEqual([{ n: 8 }]);
        expect(viaObject.rows).toEqual([{ n: 8 }]);
        expect(parseSpy).toHaveBeenCalledTimes(1);
        expect(await listBridgeStatements(client)).toHaveLength(1);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('leaves a parameterless string-form query unnamed (simple protocol)', async () => {
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        const first = await client.query('SELECT 1 AS one');
        const second = await client.query('SELECT 1 AS one');

        expect(first.rows).toEqual([{ one: 1 }]);
        expect(second.rows).toEqual([{ one: 1 }]);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('leaves a string-form query with an empty values array unnamed (deliberate guard)', async () => {
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        // values: [] means "simple protocol, no parameters" in pg — the
        // bridge must not promote it to a named extended-protocol query.
        const first = await client.query('SELECT 2 AS two', []);
        const second = await client.query('SELECT 2 AS two', []);

        expect(first.rows).toEqual([{ two: 2 }]);
        expect(second.rows).toEqual([{ two: 2 }]);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('runs a multi-statement string with an empty values array unnamed', async () => {
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        // pg resolves multi-statement simple-protocol queries with an array
        // of results. Pinned here: it neither errors nor gets a name — an
        // EQP Parse would reject the multi-statement text outright.
        const result = await client.query('SELECT 1; SELECT 2', []);

        expect(Array.isArray(result)).toBe(true);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('leaves non-DML parameterized text unnamed (EXPLAIN)', async () => {
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        // Extended protocol (values present) but not CACHEABLE_SQL — the
        // name generator must decline, on the string form like any other.
        const first = await client.query('EXPLAIN SELECT $1::int', [1]);
        const second = await client.query('EXPLAIN SELECT $1::int', [1]);

        expect(first.rows.length).toBeGreaterThan(0);
        expect(second.rows.length).toBeGreaterThan(0);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('names nothing on a statementCaching: false pool (string form included)', async () => {
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local, statementCaching: false });
    try {
      const client = await pool.connect();
      try {
        const first = await client.query('SELECT $1::int AS n', [7]);
        const second = await client.query('SELECT $1::int AS n', [7]);

        expect(first.rows).toEqual([{ n: 7 }]);
        expect(second.rows).toEqual([{ n: 7 }]);
        expect(await listBridgeStatements(client)).toEqual([]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('passes a null parameter through the string form', async () => {
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        const result = await client.query('SELECT $1::text AS v', [null]);
        expect(result.rows).toEqual([{ v: null }]);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await local.close();
    }
  });

  it('DEALLOCATE ALL evicts a string-form-cached statement — re-issue re-Parses', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local });
    try {
      const client = await pool.connect();
      try {
        // Cold execution caches the statement under a bridge-injected name.
        await client.query('SELECT $1::int AS n', [7]);

        // Session-wide wipe: PGlite forgets the statement. The eviction
        // machinery must drop pg's parse-skip entry for the string-form-
        // injected name too, or the re-issue would skip Parse straight
        // into Postgres error 26000.
        await client.query('DEALLOCATE ALL');

        parseSpy.mockClear();
        const reIssued = await client.query('SELECT $1::int AS n', [7]);
        expect(reIssued.rows).toEqual([{ n: 7 }]);
        expect(parseSpy).toHaveBeenCalledTimes(1);

        // The re-issue re-cached under a bridge-injected name.
        const names = await listBridgeStatements(client);
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/^ppb_\d+_\d+$/);
      } finally {
        client.release();
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
