import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { describe, expect, it, type MockInstance, vi } from 'vitest';

import { createTempDir, removeTempDir } from '../__tests__/file-system.ts';
import { createMockPGlite } from '../__tests__/mocks.ts';
import { setupPGlite } from '../__tests__/pglite.ts';
import { PGliteDuplex } from '../duplex/index.ts';
import { PgBridgePool, type PgBridgePoolOptions } from './index.ts';
import { PgBridgeClient } from './pg-bridge-client.ts';
import { livePoolCounts } from './session-registry.ts';

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

  it.each([0, 1.5, -1])(
    'throws the exact TypeError for max: %s — PGliteBridge pins this same message verbatim',
    async (max) => {
      // Companion to the regex pin above. The bridge's constructor-ordering
      // tests (src/pglite-bridge/construction.test.ts) assert this identical
      // message surfaces from `new PGliteBridge(...)`, so the wording is
      // load-bearing and pinned exactly here at its source.
      let constructed: PgBridgePool | undefined;
      try {
        let caught: unknown;
        try {
          constructed = new PgBridgePool({ pglite, max });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(TypeError);
        expect((caught as TypeError).message).toBe(
          `PgBridgePool: max must be a positive integer (got ${String(max)})`,
        );
      } finally {
        // Same red-phase safety as above: never leak a pool that a broken
        // guard let through.
        await constructed?.end();
      }
    },
  );
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

describe('PgBridgePool — connectionTimeoutMillis', () => {
  it('bounds a queued checkout without letting the timed-out waiter capture a later release', async () => {
    const connectionTimeoutMillis = 100;
    const cleanupBoundMillis = 1_000;
    const options = { pglite, max: 1, connectionTimeoutMillis } satisfies PgBridgePoolOptions;
    const pool = new PgBridgePool(options);
    const acquire = vi.fn();
    pool.on('acquire', acquire);
    let held: pg.PoolClient | undefined;
    let waiter: Promise<pg.PoolClient> | undefined;
    let ended = false;

    const withinCleanupBound = <T>(promise: Promise<T>, label: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`${label} did not settle within ${cleanupBoundMillis} ms`)),
          cleanupBoundMillis,
        );
        timer.unref();
        void promise.then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });

    try {
      held = await withinCleanupBound(pool.connect(), 'initial checkout');
      acquire.mockClear();

      const started = performance.now();
      waiter = pool.connect();
      await expect(withinCleanupBound(waiter, 'queued checkout')).rejects.toThrow(
        'timeout exceeded when trying to connect',
      );
      expect(performance.now() - started).toBeLessThan(cleanupBoundMillis);
      expect(acquire).not.toHaveBeenCalled();

      held.release();
      held = undefined;
      const reused = await withinCleanupBound(pool.connect(), 'post-timeout checkout');
      try {
        // pg-pool emits `acquire` even for a stale timed-out PendingItem. One
        // event proves the removed waiter did not briefly steal this release.
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(acquire).toHaveBeenCalledWith(reused);
        await expect(reused.query('SELECT 1 AS value')).resolves.toMatchObject({
          rows: [{ value: 1 }],
        });
      } finally {
        reused.release();
      }

      await withinCleanupBound(pool.end(), 'pool.end()');
      ended = true;
    } finally {
      held?.release();
      if (waiter) {
        // On the RED implementation the waiter is still queued. Releasing the
        // held client lets it resolve; immediately return that client so the
        // intentional assertion failure cannot strand a checkout.
        await withinCleanupBound(
          waiter.then(
            (lateClient) => lateClient.release(),
            () => undefined,
          ),
          'timed-out waiter cleanup',
        ).catch(() => {});
      }
      if (!ended) await withinCleanupBound(pool.end(), 'pool cleanup').catch(() => {});
    }
  });
});

describe('PgBridgePool — query_timeout forwarding', () => {
  it('forwards query_timeout as a pg client default without conflating readiness timeout', async () => {
    const pool = new PgBridgePool({
      pglite,
      query_timeout: 30_000,
      timeout: 1_234,
    });
    try {
      expect(pool.options.query_timeout).toBe(30_000);
      expect((pool.options as { timeout?: number }).timeout).toBeUndefined();

      const client = await pool.connect();
      try {
        expect(
          (
            client as unknown as {
              connectionParameters: { query_timeout: number };
            }
          ).connectionParameters.query_timeout,
        ).toBe(30_000);
      } finally {
        client.release();
      }
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
      // that shadow the prototype.
      const fakeClient = (members: Record<string, unknown>): PgBridgeClient => {
        const client = Object.create(PgBridgeClient.prototype);
        for (const [key, value] of Object.entries(members)) {
          Object.defineProperty(client, key, { value, configurable: true });
        }
        return client;
      };
      // Emit the pool's own 'connect' event with a client whose cleanup
      // query rejects — the listener must swallow it (a broken session
      // surfaces on real queries instead). No teardown stub: end()'s
      // close-barrier handles are registered at client construction via
      // onTeardownCreated, so the 'connect' listener no longer reads
      // client.teardown.
      pool.emit('connect', fakeClient({ query }));
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

  it('end() clears its losing teardown-drain timer after a successful drain', async () => {
    const realClearTimeout = globalThis.clearTimeout;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const pool = new PgBridgePool({ pglite });

    try {
      await pool.end();
      const drainTimerIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 10_000);
      expect(drainTimerIndex).toBeGreaterThanOrEqual(0);
      drainTimer = setTimeoutSpy.mock.results[drainTimerIndex]?.value;
      expect(clearTimeoutSpy).toHaveBeenCalledWith(drainTimer);
    } finally {
      if (drainTimer !== undefined) realClearTimeout(drainTimer);
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });
});

describe("PgBridgePool — end() teardown barrier for a client that never reached 'connect'", () => {
  // Bounded blocked-promise detection (same shape as the pg-bridge-client
  // suite): resolves to the settled value if `p` settles first, else the
  // sentinel 'pending' after `ms`. The loser timer is unref'd so it never
  // keeps the event loop alive after `p` wins.
  const settledOrPending = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
    Promise.race([
      p,
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), ms).unref();
      }),
    ]);

  it("end() resolves only after the failed-connect client's duplex teardown settles", async () => {
    // pg runs the client's stream factory synchronously inside the
    // PgBridgeClient constructor — the duplex exists long before pg-pool
    // could emit 'connect'. A client whose connect FAILS (here: the bridge
    // readiness timeout against a never-ready PGlite stub) therefore has a
    // live duplex tearing down that a 'connect'-time barrier registration
    // never saw, and end() could close an owned PGlite while that duplex's
    // destroy-path work is still in flight.
    const stub = createMockPGlite({
      ready: false,
      waitReady: new Promise<void>(() => {}),
    });

    // Hold the teardown-settled signal open behind a controllable gate by
    // wrapping once('close') registrations on the duplex prototype: the
    // duplex constructor's own once('close') listener is what resolves
    // `onClose` (= the teardown handle's `settled`). The stream's
    // 'error'/'close' EVENTS still flow to pg unchanged (pg's Connection
    // registers .on('error'/'close') and once('connect'/'data'), never
    // once('close')), so the connect failure propagates naturally while the
    // teardown stays deterministically un-settled until the gate opens. (A
    // `function` expression: the wrapper needs `this` to route per-duplex.)
    const closeGate = Promise.withResolvers<void>();
    const gatedDuplexes: PGliteDuplex[] = [];
    const originalOnce = PGliteDuplex.prototype.once;
    PGliteDuplex.prototype.once = function gatedOnce(
      this: PGliteDuplex,
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) {
      if (event !== 'close') return originalOnce.call(this, event, listener);
      gatedDuplexes.push(this);
      return originalOnce.call(this, event, (...args: unknown[]) => {
        void closeGate.promise.then(() => {
          listener.apply(this, args);
        });
      });
    } as typeof originalOnce;

    const pool = new PgBridgePool({ pglite: stub, timeout: 25 });
    const connectFired = vi.fn();
    pool.on('connect', connectFired);
    let ending: Promise<void> | undefined;
    try {
      // The checkout fails at the bridge readiness timeout, before pg-pool
      // ever announces the client.
      await expect(pool.connect()).rejects.toThrow(/PGlite instance not ready/);
      expect(connectFired).not.toHaveBeenCalled();

      // Exactly one duplex exists — created by the failed client's stream
      // factory — and its teardown is held open by the gate.
      expect(gatedDuplexes).toHaveLength(1);
      let teardownSettled = false;
      void gatedDuplexes[0]?.onClose.then(() => {
        teardownSettled = true;
      });

      ending = pool.end();
      // THE PIN: while that duplex's teardown is held open, end() must not
      // resolve. Pre-fix, the teardown handle was registered only in the
      // pool's 'connect' listener — which never fired for this client — so
      // end() resolves here (observed as `undefined` instead of 'pending').
      await expect(settledOrPending(ending, 250)).resolves.toBe('pending');
      expect(teardownSettled).toBe(false);

      // Releasing the held teardown is the only event between the two
      // observations — end() resolving now pins the barrier to it.
      closeGate.resolve();
      await expect(settledOrPending(ending, 5_000)).resolves.toBeUndefined();
      expect(teardownSettled).toBe(true);
    } finally {
      // Un-strand even in the red state: open the gate so the held close
      // delivers, settle the pool, then unhook the prototype gate.
      closeGate.resolve();
      const held = gatedDuplexes[0];
      if (held !== undefined) await settledOrPending(held.onClose, 2_000).catch(() => {});
      await settledOrPending(ending ?? pool.end(), 5_000).catch(() => {});
      PGliteDuplex.prototype.once = originalOnce;
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

describe('PgBridgePool — #releaseLiveSlot tolerates a missing livePoolCounts entry', () => {
  it('stores 0 (not NaN) when the livePoolCounts entry is absent before end()', async () => {
    // Change C: #releaseLiveSlot does `livePoolCounts.get(this.pglite) as number`
    // then `count - 1`. When the entry is missing, `undefined - 1` is NaN, and
    // livePoolCounts.set stores NaN forever. The fix is `?? 1` so the floor is 0.
    const local = new PGlite();
    await local.waitReady;
    const pool = new PgBridgePool({ pglite: local });
    try {
      // Simulate a missing entry by deleting the slot the constructor just wrote.
      livePoolCounts.delete(local);

      // pool.end() calls #releaseLiveSlot, which today stores NaN.
      await pool.end();

      // After the fix: must be 0, not NaN.
      const stored = livePoolCounts.get(local);
      expect(stored).toBe(0);
      expect(Number.isNaN(stored)).toBe(false);
    } finally {
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

// The Submittable arms of PgBridgeClient.query() must forward the FULL
// original argument list to stock pg. pg-pool's query() rides on exactly
// that: it hands the Submittable to client.query(text, values, cb) with its
// own completion callback in the trailing slot, releases the internal
// checkout from that callback, and settles the returned promise with the
// callback's Result. A bridge that drops the trailing arguments strands the
// checkout: the promise never settles, the max=1 client never returns to
// idle, and end() blocks forever.
describe('PgBridgePool — pool.query(Submittable) round trip', () => {
  // Bounded blocked-promise detection (same shape as the teardown-barrier
  // suite above): the settled value if `p` wins, else the sentinel 'pending'
  // after `ms`. The loser timer is unref'd so it never keeps the event loop
  // alive after `p` wins.
  const settledOrPending = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
    Promise.race([
      p,
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), ms).unref();
      }),
    ]);

  it('settles pool.query(new pg.Query(...)) with the Result, recycles the client, and stays endable', async () => {
    const pool = new PgBridgePool({ pglite, max: 1 });
    let ending: Promise<void> | undefined;
    try {
      const q = new pg.Query('SELECT 1 AS x');
      // pg.Pool's typings have no Submittable overload (pg-pool resolves a
      // promise instead of returning the stream); the runtime path exists.
      const pending = (pool.query as unknown as (...args: unknown[]) => Promise<unknown>)(q);

      // Bounded: with the trailing callback dropped, this promise NEVER
      // settles — fail here in ~5 s instead of eating the suite timeout.
      const outcome = await settledOrPending(pending, 5_000);
      expect(outcome).not.toBe('pending');

      // Stock parity: pg-pool resolves with what pg.Query's callback
      // delivered — the single statement's Result.
      const result = outcome as pg.QueryResult<{ x: number }>;
      expect(result.command).toBe('SELECT');
      expect(result.rows).toEqual([{ x: 1 }]);

      // pg-pool released its internal checkout from the completion callback,
      // so the max=1 client is idle again…
      expect(pool.idleCount).toBe(1);

      // …a follow-up pool query gets it…
      const followUp = await settledOrPending(pool.query<{ ok: number }>('SELECT 1 AS ok'), 5_000);
      expect(followUp).not.toBe('pending');
      expect((followUp as pg.QueryResult<{ ok: number }>).rows[0]?.ok).toBe(1);

      // …and end() drains instead of blocking on a stranded checkout.
      ending = pool.end();
      await expect(settledOrPending(ending, 5_000)).resolves.toBeUndefined();
    } finally {
      // Un-strand the pool even in the red state: pool.query's internal
      // checkout is never released when the callback is dropped, so end()
      // blocks on it. Force-release every still-checked-out client (pg-pool
      // attaches `release` at checkout; a double release throws and is
      // swallowed), then bound the drain — teardown must not hang.
      ending ??= pool.end();
      if ((await settledOrPending(ending, 1_000)) === 'pending') {
        const { _clients } = pool as unknown as {
          _clients: Array<{ release?: (err?: Error) => void }>;
        };
        for (const client of _clients) {
          try {
            client.release?.();
          } catch {
            // already released — nothing to un-strand
          }
        }
        await settledOrPending(ending, 10_000).catch(() => {});
      }
      // Barrier: teardown ROLLBACKs drain before the beforeEach reset runs.
      await pglite.query('SELECT 1').catch(() => {});
    }
  });
});
