import { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { createTempDir, removeTempDir } from '../__tests__/file-system.ts';
import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgePool } from './index.ts';
import { PgBridgeClient } from './pg-bridge-client.ts';

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

  it('rejects max: 0 instead of letting pg-pool silently expand it to 10 without a lock', async () => {
    let constructed: PgBridgePool | undefined;
    try {
      expect(() => {
        constructed = new PgBridgePool({ pglite, max: 0 });
      }).toThrow(/max.*positive integer/i);
    } finally {
      // Red-phase cleanup: the buggy implementation constructs an effective
      // max:10 pool, so retain and end it even though the assertion fails.
      await constructed?.end();
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
      // The listeners narrow with `instanceof PgBridgeClient`, so a synthetic
      // client must share the prototype. Object.create skips the real
      // (duplex-building) constructor; members are defined as own properties
      // that shadow the prototype (teardown is a getter, hence defineProperty
      // rather than assignment).
      const fakeClient = (members: Record<string, unknown>): PgBridgeClient => {
        const client = Object.create(PgBridgeClient.prototype);
        for (const [key, value] of Object.entries(members)) {
          Object.defineProperty(client, key, { value, configurable: true });
        }
        return client;
      };
      // Emit the pool's own 'connect' event with a client whose cleanup
      // query rejects — the listener must swallow it (a broken session
      // surfaces on real queries instead). The teardown stub feeds the
      // end() close barrier, mirroring the deregisterLiveClient stub below.
      pool.emit(
        'connect',
        fakeClient({ query, teardown: { settled: Promise.resolve(), abort: () => {} } }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(query).toHaveBeenCalledWith('DEALLOCATE ALL');
      // Balance the liveClientCounts increment from the synthetic 'connect' above;
      // without this a subsequent real connect on the same PGlite would see
      // prevClientCount > 0 and skip DEALLOCATE ALL, breaking test isolation.
      // The 'remove' listener also runs the belt-and-suspenders live-client
      // registry deregistration (ADR 002) — stub it on the synthetic client.
      pool.emit('remove', fakeClient({ deregisterLiveClient: () => {} }));
    } finally {
      await pool.end();
    }
  });

  it("creating a second pool client leaves the first client's prepared statements intact", async () => {
    // PGlite is one shared session, so a sibling's connect-time
    // DEALLOCATE ALL would destroy client A's live named statements —
    // A's next named execution would fail with Postgres error 26000.
    // With another live client in the pool, the cleanup must be skipped.
    const pool = new PgBridgePool({ pglite, max: 2 });
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
      await pglite.query('SELECT 1');
    }
  });

  it('a replacement client created after a destroy still gets the cleanup', async () => {
    // Sole-client path: pg.Pool removed the destroyed client, but PGlite's
    // shared session still holds its server-side prepared statement. The
    // replacement must see an empty statement namespace — without the
    // connect-time DEALLOCATE ALL, re-preparing the same name would fail
    // with 42P05 "prepared statement already exists".
    const pool = new PgBridgePool({ pglite, max: 1 });
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
      await pglite.query('SELECT 1');
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

  it('a draining pool with a checked-out client still counts', async () => {
    // Finding #4: end() releases the live slot synchronously, but pg-pool's
    // end() waits for checked-out clients to be released — such a client keeps
    // querying the shared PGlite during the drain while livePoolCounts no
    // longer counts the pool. A second pool constructed in that window sees no
    // overlap and emits no warning, though real cross-pool interleaving is
    // possible. Pre-fix: zero warnings.
    const local = new PGlite();
    await local.waitReady;
    const { warnings, stop } = captureSharedWarnings();
    let b: PgBridgePool | undefined;
    try {
      const a = new PgBridgePool({ pglite: local });
      const client = await a.connect();
      // Start the drain WITHOUT awaiting; the checked-out client keeps the
      // pool alive.
      const ending = a.end();
      // The hazard is real: the held client still answers a query mid-drain.
      const held = await client.query('SELECT 1');
      expect(held.rows).toEqual([{ '?column?': 1 }]);

      // A second pool joins on the same PGlite while pool A is still draining
      // with a live client — it must warn.
      b = new PgBridgePool({ pglite: local });
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]?.message ?? '').toMatch(/WASM mutex/i);

      client.release();
      await ending;
    } finally {
      stop();
      await b?.end();
      await local.close();
    }
  });

  it('a pool whose force-destroyed client is still tearing down still counts', async () => {
    // Tribunal condition on finding #4's fix: pg-pool decrements totalCount
    // SYNCHRONOUSLY when it destroys a client (release with an error), but
    // that client's duplex teardown — with its ROLLBACK against the shared
    // instance — settles asynchronously. end() called in that window must not
    // take the synchronous-release arm on totalCount alone: the slot stays
    // held until the teardown barrier settles.
    const local = new PGlite();
    await local.waitReady;
    const { warnings, stop } = captureSharedWarnings();
    let b: PgBridgePool | undefined;
    try {
      const a = new PgBridgePool({ pglite: local });
      const client = await a.connect();
      // Force-destroy: pg-pool removes the client synchronously
      // (totalCount → 0) while the duplex teardown is still in flight.
      client.release(new Error('force-destroy for teardown-window probe'));
      const ending = a.end();

      // A pool constructed while the teardown drains must still see pool A.
      b = new PgBridgePool({ pglite: local });
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]?.message ?? '').toMatch(/WASM mutex/i);

      await ending;
    } finally {
      stop();
      await b?.end();
      await local.close();
    }
  });

  it('a draining pool still counts through the end(callback) overload', async () => {
    // Callback-overload parity for finding #4: a pool constructed while the
    // held client drains must warn (the slot is still held), and a pool
    // constructed INSIDE the callback — after the deferred release completes —
    // must NOT warn. Pre-fix: the mid-drain pool does not warn (slot released
    // synchronously). The callback runs after the pool's internal
    // drainAndClose, so wrap it in a promise.
    const local = new PGlite();
    await local.waitReady;
    const { warnings, stop } = captureSharedWarnings();
    let midDrain: PgBridgePool | undefined;
    let afterDrain: PgBridgePool | undefined;
    try {
      const a = new PgBridgePool({ pglite: local });
      const client = await a.connect();

      const drained = new Promise<void>((resolve) => {
        // end(callback) fires after drainAndClose completes.
        a.end(() => resolve());
      });

      // Mid-drain: the held client keeps pool A alive, so this pool warns.
      const held = await client.query('SELECT 1');
      expect(held.rows).toEqual([{ '?column?': 1 }]);
      midDrain = new PgBridgePool({ pglite: local });
      await new Promise((resolve) => setImmediate(resolve));
      const midDrainCount = warnings.length;
      expect(midDrainCount).toBeGreaterThanOrEqual(1);
      expect(warnings[0]?.message ?? '').toMatch(/WASM mutex/i);

      // Let the drain finish, then construct a pool after the deferred release.
      await midDrain.end();
      client.release();
      await drained;

      afterDrain = new PgBridgePool({ pglite: local });
      await new Promise((resolve) => setImmediate(resolve));
      // Pool A's slot was released before its callback fired, so a pool
      // constructed now sees no live pool A — no new warning.
      expect(warnings.length).toBe(midDrainCount);
    } finally {
      stop();
      await afterDrain?.end();
      await local.close();
    }
  });
});

describe('PgBridgePool — rollback on forced client release', () => {
  it('rolls back uncommitted state when a max=1 client is destroyed mid-transaction', async () => {
    // max=1 → no SessionLock. Rollback must still run on destroy, otherwise
    // PGlite is left in 'T' state and the next connection inherits it.
    const pool = new PgBridgePool({ pglite });
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
      // Barrier: the _destroy ROLLBACK from the forced release may still be
      // settling inside PGlite's runExclusive; a direct query serializes
      // behind it before the beforeEach reset runs.
      await pglite.query('SELECT 1');
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
    await pglite.exec('CREATE TABLE t (c "char")');
    await pglite.exec(`INSERT INTO t (c) VALUES (chr(200)::"char")`);

    const native = await pglite.query<{ c: string }>('SELECT c FROM t');
    const nativeValue = native.rows[0]?.c;
    expect(nativeValue).toBeDefined();

    const pool = new PgBridgePool({ pglite });
    try {
      const bridged = await pool.query<{ c: string }>('SELECT c FROM t');
      const bridgedValue = bridged.rows[0]?.c;
      // Parity: the bridge does not corrupt or alter user "char" output beyond
      // what PGlite already produces natively.
      expect(bridgedValue).toBe(nativeValue);
    } finally {
      await pool.end();
    }
  });
});
