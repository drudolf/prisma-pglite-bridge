import type pg from 'pg';
import Cursor from 'pg-cursor';
import { afterEach, describe, expect, it } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgePool } from './index.ts';

// One shared PGlite for the whole describe instead of a fresh ~1.3s cold boot
// per test. Each test still builds its own max:2 pool (its own SessionLock), so
// no lock state leaks between tests; the afterEach below returns the shared
// session to a clean slate. `reset: false` — this file resets in afterEach, not
// setupPGlite's default beforeEach, because the reset must run AFTER each test's
// pool has fully torn down. The pool-owned-instance test is the sole exception:
// it constructs its own PGlite to prove end() closes it.
const pglite = await setupPGlite({ reset: false });

// Red-phase TDD spec for rolling back abandoned transactions on client
// release (design: .claude/plans/rollback-abandoned-tx-on-release.md).
//
// A client released back to the pool mid-transaction (a user bug: no COMMIT
// or ROLLBACK) currently leaves PGlite's shared session in 'T'/'E' state:
// other pool clients see the uncommitted data (dirty read) and the recycled
// client inherits the open transaction (E4 defect). The fix wires
// PgBridgePool's 'release' listener to call a new
// `PgBridgeClient.rollbackAbandonedTransaction()` — a no-op unless the
// duplex reports `inTransaction`, otherwise emitting exactly one
// `PGliteBridgeAbandonedTransactionWarning` and firing `query('ROLLBACK')`.
//
// Authored red-phase (TDD), before the implementation landed: without the
// fix these fail on wrong values (dirty count, inherited txid) or a missing
// warning.
describe('PgBridgePool — rollback abandoned transaction on release', () => {
  // Bounded blocked-promise detection: resolves to the settled value if `p`
  // settles first, else the sentinel `'pending'` after `ms`. Wedge-prone
  // awaits wrap their promise in this so a genuine SessionLock wedge fails
  // fast (assertion on `'pending'`) instead of hanging the worker. The loser
  // timer is unref'd so it never keeps the event loop alive after `p` wins.
  const settledOrPending = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
    Promise.race([
      p,
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), ms).unref();
      }),
    ]);

  // Teardown for a pool over the shared PGlite when a client may have been
  // abandoned mid-transaction. After `pool.end()` resolves, the abandoned
  // client's `_destroy` ROLLBACK can still be settling inside PGlite's WASM
  // `runExclusive`; a direct query serializes behind it, so it is a
  // deterministic barrier (not a timing race) before the afterEach reset runs.
  // The instance is NOT closed here — it is shared across the describe and
  // closed once by setupPGlite's afterAll. The bounded end() lets a genuine
  // SessionLock wedge fail the test instead of hanging.
  const endPoolAndClose = async (pool: PgBridgePool): Promise<void> => {
    // Tolerate a redundant call (pg-pool rejects a second end()): a test may
    // end the pool in its body and again in finally.
    await settledOrPending(pool.end(), 10_000).catch(() => {});
    // Deterministic teardown barrier: a client _destroy may still have a
    // fire-and-forget ROLLBACK in flight inside PGlite's runExclusive; a
    // direct query serializes behind it. A settle tick is a race, not a barrier.
    await pglite.query('SELECT 1').catch(() => {});
  };

  // Return the shared session to a clean slate between tests. Each test's
  // pool.end() already rolled back and the barrier above drained it, so the
  // ROLLBACK here is a defensive no-op (swallowed) that guarantees the session
  // is out of any transaction before the drops/DISCARD run. Table drops and
  // DISCARD ALL are deliberately NOT swallowed: a failure means the prior test
  // left the shared instance dirty and must fail loudly rather than silently
  // corrupt the next test's starting state. DISCARD ALL also CLOSEs any portal
  // a cursor test left suspended and DEALLOCATEs every named statement, so the
  // next test's pool starts on a genuinely empty session.
  afterEach(async () => {
    await pglite.query('ROLLBACK').catch(() => {});
    const { rows } = await pglite.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'",
    );
    for (const { t } of rows) {
      await pglite.exec(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
    await pglite.exec('DISCARD ALL');
  });

  // Capture PGliteBridgeAbandonedTransactionWarning emissions by type, like
  // the PGliteBridgeSharedInstanceWarning handling above. process.emitWarning
  // delivers on a later tick, so callers await a setImmediate before asserting.
  const captureAbandonWarnings = (): { warnings: Error[]; stop: () => void } => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      if (warning.name === 'PGliteBridgeAbandonedTransactionWarning') warnings.push(warning);
    };
    process.on('warning', onWarning);
    return {
      warnings,
      stop: () => {
        process.removeListener('warning', onWarning);
      },
    };
  };

  const flushWarnings = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('unblocks a sibling with a clean view and recycles the client outside any transaction (E4)', async () => {
    // max: 2. Client A opens a transaction and INSERTs, then plain-releases
    // (no error). Currently the abandoned tx stays open on the shared session:
    // B reads count 1 (dirty) and the recycled client inherits a non-null
    // txid. After the fix the release-time ROLLBACK clears it — B sees count 0
    // and the recycled client's first query runs outside any tx. This also
    // behaviorally pins the pg-pool release→pulse ordering: the recycled
    // client's first user query must observe a clean session.
    const pool = new PgBridgePool({ pglite, max: 2 });
    let recycled: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE e4 (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO e4 VALUES (1)');
      // Abandoned release: no COMMIT/ROLLBACK, no error.
      a.release();

      const b = await pool.connect();
      try {
        // Bounded: a SessionLock wedge would leave this 'pending' — either
        // way (dirty count 1 red-phase, or a wedge) the assertion fails for
        // the right reason until the release-time ROLLBACK lands.
        const bCount = await settledOrPending(
          b.query<{ count: string }>('SELECT count(*)::text AS count FROM e4'),
          1500,
        );
        expect(bCount).not.toBe('pending');
        expect((bCount as pg.QueryResult<{ count: string }>).rows[0]?.count).toBe('0');
      } finally {
        b.release();
      }

      // The recycled client (pg-pool reuses A) must start outside any tx.
      recycled = await pool.connect();
      const txid = await settledOrPending(
        recycled.query<{ t: string | null }>('SELECT txid_current_if_assigned() AS t'),
        1500,
      );
      expect(txid).not.toBe('pending');
      expect((txid as pg.QueryResult<{ t: string | null }>).rows[0]?.t).toBeNull();

      const recycledCount = await recycled.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM e4',
      );
      expect(recycledCount.rows[0]?.count).toBe('0');
    } finally {
      // Red-phase teardown guard: if the fix is absent the recycled client is
      // still inside the inherited transaction, so ROLLBACK manually before
      // ending — otherwise pool.end() could wedge on a stuck-in-tx client. If
      // the assertion above threw first, `recycled` is undefined and client A
      // stays idle-in-tx; endPoolAndClose's barrier query drains the teardown
      // rollback before the afterEach reset runs.
      await recycled?.query('ROLLBACK').catch(() => {});
      recycled?.release();
      await endPoolAndClose(pool);
    }
  });

  it('emits exactly one PGliteBridgeAbandonedTransactionWarning per abandoned release', async () => {
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let recycled: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE warn_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO warn_t VALUES (1)');
      a.release();
      await flushWarnings();

      // Exactly one warning for the single abandoned release.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message ?? '').toMatch(/ROLLBACK/i);

      // The rollback must have settled the session — drain any recycled state.
      recycled = await pool.connect();
      await recycled.query('ROLLBACK').catch(() => {});
    } finally {
      stop();
      await recycled?.query('ROLLBACK').catch(() => {});
      recycled?.release();
      await endPoolAndClose(pool);
    }
  });

  it('does not warn on a clean release (all queries awaited, COMMIT sent)', async () => {
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE clean_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO clean_t VALUES (1)');
      // Await the COMMIT so the RFQ status has returned to 'I' before release
      // — an in-flight COMMIT at release time could leave a stale 'T' and
      // spuriously warn.
      await a.query('COMMIT');
      a.release();
      await flushWarnings();

      expect(warnings).toHaveLength(0);
    } finally {
      stop();
      await endPoolAndClose(pool);
    }
  });

  it('does not warn when a client is released with an error mid-transaction', async () => {
    // release(err) destroys the client; the E5-verified _destroy path
    // (rollbackIfInTransaction) handles cleanup. The NEW warning must not fire
    // — the pool's 'release' listener only calls rollbackAbandonedTransaction
    // when err == null.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE errrel_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO errrel_t VALUES (1)');
      a.release(new Error('forced destroy'));
      await flushWarnings();

      expect(warnings).toHaveLength(0);

      // Destroy-path rollback still cleared the session: a fresh checkout sees
      // no uncommitted row.
      const b = await pool.connect();
      try {
        const r = await b.query<{ count: string }>('SELECT count(*)::text AS count FROM errrel_t');
        expect(r.rows[0]?.count).toBe('0');
      } finally {
        b.release();
      }
    } finally {
      stop();
      await endPoolAndClose(pool);
    }
  });

  it('does not warn during a plain pool.end() with no abandonment', async () => {
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    try {
      const a = await pool.connect();
      await a.query('SELECT 1');
      a.release();
      const b = await pool.connect();
      await b.query('SELECT 2');
      b.release();
      // Ending a pool holding only cleanly-released idle clients must not emit
      // the abandoned-transaction warning.
      await endPoolAndClose(pool);
      await flushWarnings();
      expect(warnings).toHaveLength(0);
    } finally {
      stop();
      await endPoolAndClose(pool);
    }
  });

  it('max: 1 — the next checkout starts clean after an abandoned tx (state-leak facet, no lock)', async () => {
    // No SessionLock exists at max: 1, so there is no wedge to fix — only the
    // state leak. The recycled sole client must still start outside the
    // inherited transaction and not see the abandoned row.
    const pool = new PgBridgePool({ pglite, max: 1 });
    let next: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE m1_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO m1_t VALUES (1)');
      a.release();

      next = await pool.connect();
      const txid = await settledOrPending(
        next.query<{ t: string | null }>('SELECT txid_current_if_assigned() AS t'),
        1500,
      );
      expect(txid).not.toBe('pending');
      expect((txid as pg.QueryResult<{ t: string | null }>).rows[0]?.t).toBeNull();

      const r = await next.query<{ count: string }>('SELECT count(*)::text AS count FROM m1_t');
      expect(r.rows[0]?.count).toBe('0');
    } finally {
      await next?.query('ROLLBACK').catch(() => {});
      next?.release();
      await endPoolAndClose(pool);
    }
  });

  it('failed-tx variant — abandoning an errored transaction (state E) warns, rolls back, stays usable', async () => {
    // A opens a transaction and issues a failing query (session enters 'E'),
    // then plain-releases. The abandoned failed transaction must be rolled
    // back: the warning fires and the pool is usable afterward with a clean
    // view.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let recycled: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE fail_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO fail_t VALUES (1)');
      // A failing statement inside the transaction moves the session to 'E'.
      await a.query('SELECT nope_column FROM fail_t').catch(() => {});
      a.release();
      await flushWarnings();

      expect(warnings).toHaveLength(1);

      const b = await pool.connect();
      try {
        // The session recovered from 'E' via the ROLLBACK; a normal query runs.
        const r = await settledOrPending(
          b.query<{ count: string }>('SELECT count(*)::text AS count FROM fail_t'),
          1500,
        );
        expect(r).not.toBe('pending');
        expect((r as pg.QueryResult<{ count: string }>).rows[0]?.count).toBe('0');
      } finally {
        b.release();
      }

      // Recycled client is outside any transaction.
      recycled = await pool.connect();
      const txid = await recycled.query<{ t: string | null }>(
        'SELECT txid_current_if_assigned() AS t',
      );
      expect(txid.rows[0]?.t).toBeNull();
    } finally {
      stop();
      await recycled?.query('ROLLBACK').catch(() => {});
      recycled?.release();
      await endPoolAndClose(pool);
    }
  });

  it('tolerates pool.end() fired immediately after an abandoned release with no unhandled rejection', async () => {
    // Teardown fired without awaiting the in-flight release-ROLLBACK. The
    // concurrent _destroy rollbackIfInTransaction and the chained ROLLBACK
    // serialize through PGlite; neither may surface an unhandledRejection.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const pool = new PgBridgePool({ pglite, max: 2 });
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE endrace_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO endrace_t VALUES (1)');
      a.release();
      // No await between the abandoned release and end().
      const ended = await settledOrPending(pool.end(), 3000);
      expect(ended).not.toBe('pending');

      // Let any deferred rejection surface.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      // The pool was ended in the body; settle any in-flight teardown rollback
      // before closing PGlite (WASM-mutex deadlock guard).
      await endPoolAndClose(pool);
    }
  });

  it('delayed-BEGIN window — unawaited BEGIN then immediate release leaves no permanent damage', async () => {
    // Fire BEGIN WITHOUT awaiting, then release immediately: lastSeenRfqStatus
    // may still read 'I' at release time, so the rollback is legitimately
    // skipped (a double user bug). This test is deliberately tolerant of both
    // outcomes — rollback fired OR skipped — and pins only "no permanent
    // wedge": after the BEGIN settles, a subsequent checkout/release cycle and
    // pool.end() leave the pool usable. This passes under BOTH current and
    // fixed behavior (there is no permanent damage in either), so it is a
    // guard against regressions in the skip path, not a red-until-fixed test.
    const pool = new PgBridgePool({ pglite, max: 2 });
    let next: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE delayed_t (id int)');
      // Fire-and-forget BEGIN — not awaited before release.
      const beginP = a.query('BEGIN').catch(() => {});
      a.release();
      // Let the in-flight BEGIN settle.
      await beginP;

      // A subsequent checkout/release cycle must work; if the delayed BEGIN
      // left the session in 'T', roll it back so teardown stays possible.
      next = await pool.connect();
      const usable = await settledOrPending(next.query<{ one: number }>('SELECT 1 AS one'), 1500);
      // Either the session was clean (skip path) or a leftover 'T' surfaces
      // here — in both cases the query resolves; a permanent wedge would not.
      expect(usable).not.toBe('pending');
      await next.query('ROLLBACK').catch(() => {});
      next.release();
    } finally {
      await endPoolAndClose(pool);
    }
  });

  it('named statements promoted inside a transaction survive its ROLLBACK (probe-confirmed PG parity)', async () => {
    // Tribunal-mandated statement-cache exposure probe. Statement caching is
    // on by default: a parameterized shape earns a protocol-level prepared
    // statement on its SECOND sighting. Promote it INSIDE an open transaction,
    // ROLLBACK, then re-execute the shape. A scratch probe against this exact
    // PGlite confirmed protocol-prepared statements are SESSION-scoped (stock
    // PG behavior): the name survives the ROLLBACK and the re-execution runs
    // warm. This test passes under BOTH current and fixed behavior — the fix
    // does not touch statement scoping — so it is a standing guard on that
    // invariant, not a red-until-fixed test. (If a future PGlite destroyed
    // protocol-prepared statements on ROLLBACK the re-execution would fail
    // 26000 and this test would flip red, flagging the divergence.)
    const pool = new PgBridgePool({ pglite, max: 1 });
    try {
      const client = await pool.connect();
      try {
        const shape = () => ({ text: 'SELECT $1::int AS n', values: [1] });

        await client.query('BEGIN');
        // Two sightings promote the shape (K=2 admission gate) inside the tx.
        await client.query(shape());
        const promoted = await client.query(shape());
        expect(promoted.rows).toEqual([{ n: 1 }]);

        const inTx = await pglite.query<{ name: string }>(
          "SELECT name FROM pg_prepared_statements WHERE name LIKE 'ppb_%'",
        );
        expect(inTx.rows).toHaveLength(1);

        await client.query('ROLLBACK');

        // The protocol-prepared statement survives the rollback…
        const afterRollback = await pglite.query<{ name: string }>(
          "SELECT name FROM pg_prepared_statements WHERE name LIKE 'ppb_%'",
        );
        expect(afterRollback.rows).toHaveLength(1);

        // …and the shape re-executes warm (no 26000 "prepared statement does
        // not exist").
        const reExecuted = await client.query(shape());
        expect(reExecuted.rows).toEqual([{ n: 1 }]);
      } finally {
        client.release();
      }
    } finally {
      await endPoolAndClose(pool);
    }
  });

  it('does not fire a rollback at a client abandoned mid-cursor (wedged — no warning, pool usable)', async () => {
    // Pins the wedged-client guard: a client released mid-operation (here, an
    // open pg-cursor whose Submittable never completes) must NOT enqueue an
    // undeliverable ROLLBACK. Probe-verified (plan, second amendment): the
    // forced mid-portal ReadyForQuery reports `I`, so `inTransaction` is
    // false here and the guard is a redundant second gate for this shape —
    // it stays for clients released with a real open transaction plus an
    // in-flight operation, where a chained ROLLBACK could never reach the
    // wire. The historical dead-WASM spin lived on the SIBLING inheriting
    // the dangling implicit transaction (see the sibling regression below).
    // Assert no warning fires and the pool stays usable on a sibling client.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    try {
      // Check out both up front: the abandoned client A itself stays wedged
      // (pg-side never turns ready), so the assertion is that OTHER clients
      // are not blocked behind the abandoned portal's hold.
      const a = await pool.connect();
      const b = await pool.connect();
      try {
        const cursor = a.query(
          new Cursor<{ i: number }>('select i from generate_series(1,6) g(i)'),
        );
        await cursor.read(2);
        // Plain release WITHOUT closing the cursor — the client is wedged.
        a.release();
        await flushWarnings();

        // The wedged-client guard skips before the warning: none must fire.
        expect(warnings).toHaveLength(0);

        // The sibling client can still run a query — the pool is not wedged.
        const r = await settledOrPending(b.query<{ ok: number }>('SELECT 1 AS ok'), 1500);
        expect(r).not.toBe('pending');
        expect((r as pg.QueryResult<{ ok: number }>).rows[0]?.ok).toBe(1);
      } finally {
        b.release();
      }
    } finally {
      stop();
      await endPoolAndClose(pool);
    }
  });

  it('sibling of an abandoned cursor stays clean: no inherited transaction, no spurious warning on its release', async () => {
    // Fix 1 regression (second amendment): a plain-released client that
    // abandoned a suspended pg-cursor portal leaves the backend's IMPLICIT
    // transaction open — its terminating Sync never arrives. Today the next
    // query from ANY sibling returns ReadyForQuery 'T', the sibling's duplex
    // records it, and the sibling's perfectly clean release() then fires a
    // spurious PGliteBridgeAbandonedTransactionWarning plus a release-time
    // ROLLBACK it never needed. The fix manufactures the terminating Sync at
    // the ABANDONING client's release, before the session lock is released,
    // so siblings run on a genuinely idle session.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let b: pg.PoolClient | undefined;
    let bReleased = false;
    try {
      // Check out both up front: the abandoned client A itself stays wedged
      // (pg-side never turns ready); the fix is about its SIBLINGS.
      const a = await pool.connect();
      b = await pool.connect();

      const cursor = a.query(new Cursor<{ i: number }>('select i from generate_series(1,6) g(i)'));
      await cursor.read(2);
      // Plain release WITHOUT closing the cursor — the portal is abandoned.
      a.release();
      await flushWarnings();

      // The abandoning client itself never warns: its mid-portal RFQ status
      // reads 'I' at release time.
      expect(warnings).toHaveLength(0);

      // The sibling is not blocked behind the abandoned portal's hold.
      const r = await settledOrPending(b.query<{ ok: number }>('SELECT 1 AS ok'), 1500);
      expect(r).not.toBe('pending');
      expect((r as pg.QueryResult<{ ok: number }>).rows[0]?.ok).toBe(1);

      // KEY DISCRIMINATOR 1 — today this reads `true`: B inherited the
      // dangling implicit transaction from A's abandoned portal. The
      // release-time recovery Sync closes it before the lock is released, so
      // B's ReadyForQuery reports 'I'. (Same pg-internals access precedent as
      // elsewhere in the suite.)
      const internals = b as unknown as {
        connection: { stream: { inTransaction: boolean } };
      };
      expect(internals.connection.stream.inTransaction).toBe(false);

      // KEY DISCRIMINATOR 2 — today this perfectly clean release fires one
      // misattributed PGliteBridgeAbandonedTransactionWarning at the innocent
      // sibling (probe-verified, second amendment). It must stay silent.
      b.release();
      bReleased = true;
      await flushWarnings();
      expect(warnings).toHaveLength(0);
    } finally {
      stop();
      // Red-phase guard: if a discriminator threw before B's release, return
      // it so pool.end() does not wait out the checkout.
      if (b !== undefined && !bReleased) b.release();
      await endPoolAndClose(pool);
    }
  });

  it('pool.end() on a pool-owned PGlite settles after an abandoned-tx release and closes the instance', {
    timeout: 30_000,
  }, async () => {
    // Fix 2 regression (teardown barrier): pg-pool 3.14's end() resolves
    // WITHOUT waiting for client teardown, and PgBridgePool.end() then
    // closes a pool-OWNED PGlite concurrently with the in-flight teardown
    // rollback of an abandoned client — closing the WASM instance
    // mid-rollback arms the dead-WASM spin. The fixed end() awaits all
    // client duplex teardowns (bounded ~10s drain) before closing an owned
    // instance; new contract: when end() resolves on a pool that owns its
    // PGlite, that PGlite is closed. A race guard, not strictly red-first.
    // NO pglite option here — the pool must own and close the instance
    // itself, so endPoolAndClose (caller-owned teardown) does not apply.
    const pool = new PgBridgePool({ max: 2 });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE endown_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO endown_t VALUES (1)');
      // Abandoned release, then end() with no await between: end() must not
      // race the release-time ROLLBACK into a dead-WASM spin. (The one
      // expected abandoned-tx warning is exercised elsewhere — deliberately
      // not captured here.)
      a.release();
      const ended = await settledOrPending(pool.end(), 15_000);
      // A dead-WASM spin or an unbounded barrier would leave this pending;
      // the ~10s drain bound must let end() settle.
      expect(ended).not.toBe('pending');

      // New end() contract: the owned instance is closed by the time end()
      // resolves.
      expect(pool.pglite.closed).toBe(true);

      // Let any deferred rejection surface.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      // Redundant when the body ended the pool (pg-pool rejects a second
      // end()); only meaningful if an assertion threw before end() settled.
      await settledOrPending(pool.end(), 10_000).catch(() => {});
    }
  });
});
