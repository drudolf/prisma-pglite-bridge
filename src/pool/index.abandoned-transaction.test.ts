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

  // Fast-query `types` doubles for the FIX 1 tests below (fast-array-parsers
  // cast precedent — @types/pg's CustomTypesConfig mistypes getTypeParser).
  // goodTypes is the identity-parser adapter-pg shape used to WARM the fast
  // path; throwingTypes(err) throws from getTypeParser, tripping the warm
  // path at submit time on the second sighting of the same named statement.
  const goodTypes = {
    getTypeParser: () => (raw: string) => raw,
  } as unknown as pg.CustomTypesConfig;
  const throwingTypes = (err: Error): pg.CustomTypesConfig =>
    ({
      getTypeParser: (): never => {
        throw err;
      },
    }) as unknown as pg.CustomTypesConfig;

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

  it('rolls back after a finite in-flight query settles so a sibling does not remain blocked', async () => {
    const pool = new PgBridgePool({ pglite, max: 2 });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    let aReleased = false;
    let sibling: Promise<pg.QueryResult<{ one: number }>> | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      await a.query('BEGIN');

      // Release while an ordinary, finite query is active. The eager release
      // hook cannot ROLLBACK yet, but it must arrange a cleanup barrier after
      // this query settles; treating it like a permanently wedged cursor leaves
      // the SessionLock owned forever.
      const inFlight = a.query('SELECT pg_sleep(0.05)');
      a.release();
      aReleased = true;
      sibling = b.query<{ one: number }>('SELECT 1 AS one');
      sibling.catch(() => {});

      await inFlight;
      const outcome = await settledOrPending(sibling, 1_500);
      expect(outcome).not.toBe('pending');
      if (outcome !== 'pending') expect(outcome.rows[0]?.one).toBe(1);
    } finally {
      if (a && !aReleased) a.release();

      if (sibling) {
        // Red-phase recovery: check out released client A and manually clear
        // the transaction so the intentionally failing assertion cannot leave
        // client B or the shared PGlite wedged for later tests.
        const recovery = await pool.connect();
        try {
          await recovery.query('ROLLBACK').catch(() => {});
        } finally {
          recovery.release();
        }
        await sibling.catch(() => {});
      }
      b?.release();
      await endPoolAndClose(pool);
    }
  });

  it('runs the deferred ROLLBACK after in-flight chained work but before the next checkout query (max: 1)', async () => {
    // Recycle-ordering pin: the cleanup link is registered SYNCHRONOUSLY on
    // the submission chain at release, so it is ordered AFTER the unawaited
    // in-flight pg_sleep but AHEAD of any query the next checkout submits on
    // the recycled client. That checkout must therefore see the INSERT rolled
    // back and inherit no open transaction.
    const pool = new PgBridgePool({ pglite, max: 1 });
    const { warnings, stop } = captureAbandonWarnings();
    let next: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE recycle_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO recycle_t VALUES (1)');
      // Unawaited and still in flight at release time.
      void a.query('SELECT pg_sleep(0.05)');
      a.release();

      // pg-pool recycles the sole client; its queries join the same
      // submission chain, so they serialize behind the sleep AND the cleanup
      // link. Bounded so a wedge fails fast instead of hanging the worker.
      next = await pool.connect();
      const count = await settledOrPending(
        next.query<{ count: string }>('SELECT count(*)::text AS count FROM recycle_t'),
        1_500,
      );
      expect(count).not.toBe('pending');
      if (count !== 'pending') expect(count.rows[0]?.count).toBe('0');

      // No inherited open transaction on the recycled client.
      const clean = await next.query<{ clean: boolean }>(
        'SELECT pg_current_xact_id_if_assigned() IS NULL AS clean',
      );
      expect(clean.rows[0]?.clean).toBe(true);

      await flushWarnings();
      expect(warnings).toHaveLength(1);
    } finally {
      stop();
      // Red-phase recovery: the recycled client may still be inside the
      // inherited transaction — clear it before teardown.
      await next?.query('ROLLBACK').catch(() => {});
      next?.release();
      await endPoolAndClose(pool);
    }
  });

  it('stays silent when the unawaited in-flight query was the COMMIT itself (no-op re-check arm)', async () => {
    // The cleanup link must re-check transaction state when it RUNS, not
    // trust a snapshot from release time: here the release-time status still
    // reads 'T' (the COMMIT is in flight), but by the time the link runs the
    // COMMIT has won. A snapshot-based implementation would fire a spurious
    // warning and a ROLLBACK it never needed. Like the delayed-BEGIN window
    // above, this guards the no-op arm rather than being red-until-fixed.
    const pool = new PgBridgePool({ pglite, max: 1 });
    const { warnings, stop } = captureAbandonWarnings();
    let next: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE commitwin_t (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO commitwin_t VALUES (1)');
      void a.query('COMMIT');
      a.release();

      // Settle barrier: the recycled client's query chains behind the COMMIT
      // and the cleanup link, so the link has run by the time this resolves.
      next = await pool.connect();
      const count = await settledOrPending(
        next.query<{ count: string }>('SELECT count(*)::text AS count FROM commitwin_t'),
        1_500,
      );
      expect(count).not.toBe('pending');
      // The COMMIT won — no spurious ROLLBACK undid the insert.
      if (count !== 'pending') expect(count.rows[0]?.count).toBe('1');

      await flushWarnings();
      expect(warnings).toHaveLength(0);
    } finally {
      stop();
      next?.release();
      await endPoolAndClose(pool);
    }
  });

  it('recovers an unawaited BEGIN: the cleanup link rolls back once it settles and warns exactly once', async () => {
    // Upgrade over the delayed-BEGIN window test above (which tolerates both
    // outcomes): the release-time status reads 'I' while the BEGIN is still
    // in flight, so the old release-time check legitimately skipped — leaving
    // the SessionLock held forever once the BEGIN settled. The deferred
    // cleanup link runs after the BEGIN settles, re-checks, finds 'T', emits
    // exactly one PGliteBridgeAbandonedTransactionWarning and ROLLBACKs —
    // unblocking sibling B.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let b: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      b = await pool.connect();

      // Unawaited at RELEASE time — that is the whole window.
      const beginP = a.query('BEGIN');
      beginP.catch(() => {});
      a.release();
      // Deterministic red: let the BEGIN settle so the session really is in
      // a transaction before the sibling queries (mirrors the delayed-BEGIN
      // test's settle await).
      await beginP.catch(() => {});

      const sibling = b.query<{ ok: number }>('SELECT 1 AS ok');
      sibling.catch(() => {});
      const outcome = await settledOrPending(sibling, 1_500);
      expect(outcome).not.toBe('pending');
      if (outcome !== 'pending') expect(outcome.rows[0]?.ok).toBe(1);

      // Warning barrier: the recycled client (A) chains this query behind
      // the BEGIN and its cleanup link, so the single warning is a mere
      // emit-tick away by the time it resolves.
      const barrier = await pool.connect();
      try {
        await barrier.query('SELECT 1');
      } finally {
        barrier.release();
      }
      await flushWarnings();
      expect(warnings).toHaveLength(1);
    } finally {
      stop();
      // Red-phase recovery: clear the leaked transaction through a recovery
      // checkout (pg-pool hands back recycled A) so the shared instance is
      // not poisoned for later tests.
      const recovery = await pool.connect().catch(() => undefined);
      if (recovery !== undefined) {
        await recovery.query('ROLLBACK').catch(() => {});
        recovery.release();
      }
      b?.release();
      await endPoolAndClose(pool);
    }
  });

  it('composite window: suspended cursor inside an explicit tx — wedge bounded by pool lifetime, teardown recovers', async () => {
    // DESIGN-FORK RESOLUTION (tribunal-mandated probe). This composition —
    // an abandoned suspended portal AND chained work (the unawaited tail
    // query queued behind the cursor) inside an explicit BEGIN — was the
    // open question of the deferred-cleanup review: is the chain-presence
    // discriminator sound here? The probe's verdict: the wedge is NOT a
    // discriminator artifact and no release-time cleanup can lift it.
    // releaseAbandonedPortalHold deliberately keeps ownership on a T/E
    // status (a real transaction needs its COMMIT/ROLLBACK), while the
    // cleanup link is queued behind a tail that can only settle after a
    // terminating Sync that never comes — each side correctly defers to the
    // other. The reviewed fallback (an explicit bridge-managed-active flag)
    // is behaviorally inert here: it would skip registering a dormant link,
    // and the sibling stays blocked either way. What this test PINS is the
    // contract the shipped design does guarantee, matching the documented
    // "waits unboundedly behind another client's open transaction or
    // suspended portal" (PgBridgePoolOptions.max): the wedge is bounded by
    // the POOL's lifetime, the dormant cleanup link stays silent (no
    // warning for a ROLLBACK it can never deliver), pool.end() settles (the
    // destroy-time rollbackIfInTransaction frees the session out-of-band),
    // nothing leaks as an unhandledRejection, and the shared session is
    // clean afterwards. The root fix — manufacturing the portal-abandon
    // recovery Sync inside an explicit transaction too, so the tail and the
    // cleanup link can drain — is a duplex-level design change deferred to
    // its own review round.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    let sibling: Promise<pg.QueryResult<{ one: number }>> | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      await a.query('BEGIN');

      // Portal suspended inside the explicit transaction…
      const cursor = a.query(new Cursor<{ i: number }>('select i from generate_series(1,50) g(i)'));
      await cursor.read(5);
      // …with an ordinary query queued behind the wedged cursor.
      const tail = a.query('SELECT 1');
      tail.catch(() => {});
      a.release();

      // The sibling waits behind A's still-open transaction — the documented
      // unbounded wait. Pinned as 'pending' so a future duplex-level fix that
      // unblocks it announces itself here (flip this to a settle assertion).
      sibling = b.query<{ one: number }>('SELECT 1 AS one');
      sibling.catch(() => {});
      const outcome = await settledOrPending(sibling, 1_200);
      expect(outcome).toBe('pending');

      // The dormant cleanup link must not warn about a ROLLBACK it cannot
      // deliver — the warning belongs to cleanups that actually run.
      await flushWarnings();
      expect(warnings).toHaveLength(0);

      // Teardown recovery: B releases with its query still queued (its own
      // cleanup link no-ops — no transaction), and end() must settle within
      // the drain bound. Asserted here because endPoolAndClose in finally
      // deliberately swallows a pending end() — a wedge would pass silently.
      b.release();
      b = undefined;
      const ended = await settledOrPending(pool.end(), 10_000);
      expect(ended).not.toBe('pending');

      // The blocked sibling settles once teardown cancels its lock wait
      // (rejection — its client was destroyed), rather than leaking forever.
      const siblingSettled = await settledOrPending(
        sibling.then(
          () => 'settled',
          () => 'settled',
        ),
        2_000,
      );
      expect(siblingSettled).toBe('settled');

      // Destroy-path rollbackIfInTransaction freed the session out-of-band:
      // the shared instance is idle and usable, and the wedge died with the
      // pool. No dead-WASM spin: this direct query serializes behind any
      // in-flight teardown work inside runExclusive.
      const alive = await pglite.query<{ ok: number }>('SELECT 1 AS ok');
      expect(alive.rows[0]?.ok).toBe(1);

      // The dormant link drained during teardown without firing (destroyed
      // duplex re-check) and nothing surfaced as an unhandledRejection.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
      await flushWarnings();
      expect(warnings).toHaveLength(0);
    } finally {
      stop();
      process.removeListener('unhandledRejection', onRejection);
      b?.release();
      // Defensive: clear any backend 'T' directly on the shared session so
      // the afterEach reset starts clean even if an assertion above threw
      // before teardown ran.
      await pglite.query('ROLLBACK').catch(() => {});
      await endPoolAndClose(pool);
    }
  });

  it('tolerates pool.end() racing the deferred cleanup of an unawaited in-flight query', async () => {
    // Targets the duplex-destroyed re-check arm: end() fires while the
    // pg_sleep is still in flight, so the cleanup link typically finds the
    // duplex already destroyed and goes silent (duplex _destroy's
    // rollbackIfInTransaction is the backstop). The exact arm hit is
    // timing-dependent — the link may instead win the race and roll back
    // first — so only the invariants are pinned: end() settles, nothing
    // surfaces as an unhandledRejection, at most one warning, and the shared
    // session stays usable.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    try {
      const a = await pool.connect();
      await a.query('BEGIN');
      void a.query('SELECT pg_sleep(0.3)').catch(() => {});
      a.release();
      // No await between the release and end(): teardown races both the
      // still-running sleep and the chained cleanup link.
      const ended = await settledOrPending(pool.end(), 10_000);
      expect(ended).not.toBe('pending');

      // Deterministic drain: a direct query serializes behind any in-flight
      // sleep/rollback inside PGlite's runExclusive — the session is usable.
      const alive = await pglite.query<{ ok: number }>('SELECT 1 AS ok');
      expect(alive.rows[0]?.ok).toBe(1);

      // Let any deferred rejection and warning surface.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(rejections).toEqual([]);
      await flushWarnings();
      expect(warnings.length).toBeLessThanOrEqual(1);
    } finally {
      stop();
      process.removeListener('unhandledRejection', onRejection);
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

  it('buffered warm-parser failure: release after its rejection settles rolls back and unblocks the sibling', async () => {
    // FIX 1 (fast-query buffered submit-time rejection), window 1. A warm
    // fast-path query whose types.getTypeParser throws used to reject
    // IMMEDIATELY inside submit while pg's active-query slot stayed occupied
    // — the release issued from the rejection handler then saw a "wedged"
    // client and skipped the abandoned-tx cleanup, leaking the open
    // transaction and the SessionLock forever. Buffering the error until the
    // recovery Sync's ReadyForQuery keeps the submission chain occupied
    // through the failure, so this release fires the cleanup: sibling
    // unblocked, exactly one warning, clean session.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let a: pg.PoolClient | undefined;
    let aReleased = false;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      await a.query('BEGIN');

      // Warm the fast path: running the named statement once with working
      // types caches its result fields, so the SECOND run hits getTypeParser
      // at submit time.
      await a.query({
        name: 'leak_w',
        text: 'SELECT 1 AS n',
        rowMode: 'array',
        values: [],
        types: goodTypes,
      });

      const boom = new Error('warm parser boom');
      const failing = a.query({
        name: 'leak_w',
        text: 'SELECT 1 AS n',
        rowMode: 'array',
        values: [],
        types: throwingTypes(boom),
      });
      // Bounded: the buffered error must flush at the recovery Sync's RFQ —
      // a buffer that never drains would leave this pending.
      const failure = await settledOrPending(
        failing.then(
          () => 'resolved' as const,
          (err: unknown) => err,
        ),
        1_500,
      );
      expect(failure).toBe(boom);

      // Release AFTER the rejection handler ran — the window that used to
      // skip the cleanup.
      a.release();
      aReleased = true;

      // The cleanup ROLLBACK released the SessionLock: the sibling settles
      // instead of queueing forever behind the leaked transaction.
      const sibling = b.query<{ ok: number }>('SELECT 1 AS ok');
      sibling.catch(() => {});
      const outcome = await settledOrPending(sibling, 1_500);
      expect(outcome).not.toBe('pending');
      if (outcome !== 'pending') expect(outcome.rows[0]?.ok).toBe(1);

      // B's view is clean: its RFQ reports 'I', not an inherited 'T' from
      // A's abandoned BEGIN (same pg-internals precedent as the
      // sibling-cursor test above).
      const internals = b as unknown as {
        connection: { stream: { inTransaction: boolean } };
      };
      expect(internals.connection.stream.inTransaction).toBe(false);

      await flushWarnings();
      expect(warnings).toHaveLength(1);
    } finally {
      stop();
      if (a && !aReleased) a.release();
      b?.release();
      // Red-phase recovery: clear any leaked 'T' directly on the shared
      // session so a red run cannot poison later tests; endPoolAndClose's
      // bounded end() contains a wedged SessionLock.
      await pglite.query('ROLLBACK').catch(() => {});
      await endPoolAndClose(pool);
    }
  });

  it('buffered warm-parser failure: release while the failing query is in flight rolls back and unblocks the sibling', async () => {
    // FIX 1, window 2: release() lands BEFORE the buffered rejection flushes.
    // The occupied chain defers the cleanup link behind the failing query's
    // recovery Sync; when its RFQ arrives the link finds 'T', warns once and
    // ROLLBACKs — previously this window skipped the cleanup outright.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let a: pg.PoolClient | undefined;
    let aReleased = false;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      await a.query('BEGIN');

      await a.query({
        name: 'leak_w2',
        text: 'SELECT 1 AS n',
        rowMode: 'array',
        values: [],
        types: goodTypes,
      });

      const boom = new Error('warm parser boom 2');
      const failing = a.query({
        name: 'leak_w2',
        text: 'SELECT 1 AS n',
        rowMode: 'array',
        values: [],
        types: throwingTypes(boom),
      });
      failing.catch(() => {});
      // Release with the failing query still in flight — no await between.
      a.release();
      aReleased = true;

      const failure = await settledOrPending(
        failing.then(
          () => 'resolved' as const,
          (err: unknown) => err,
        ),
        1_500,
      );
      expect(failure).toBe(boom);

      const sibling = b.query<{ ok: number }>('SELECT 1 AS ok');
      sibling.catch(() => {});
      const outcome = await settledOrPending(sibling, 1_500);
      expect(outcome).not.toBe('pending');
      if (outcome !== 'pending') expect(outcome.rows[0]?.ok).toBe(1);

      await flushWarnings();
      expect(warnings).toHaveLength(1);
    } finally {
      stop();
      if (a && !aReleased) a.release();
      b?.release();
      await pglite.query('ROLLBACK').catch(() => {});
      await endPoolAndClose(pool);
    }
  });

  it('buffered Bind-serialization failure inside BEGIN: release after rejection rolls back and unblocks the sibling', async () => {
    // FIX 1, the other submit-time throw: serializing a circular structure
    // in `values` fails while building Bind. Buffered until the recovery
    // Sync's RFQ like the warm-parser throw — the release that follows the
    // rejection must fire the abandoned-tx cleanup instead of leaking the
    // transaction and the SessionLock.
    const pool = new PgBridgePool({ pglite, max: 2 });
    const { warnings, stop } = captureAbandonWarnings();
    let a: pg.PoolClient | undefined;
    let aReleased = false;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();
      await a.query('BEGIN');

      const circular: unknown[] = [];
      circular.push(circular);
      const failing = a.query({
        name: 'leak_b',
        text: 'SELECT $1::text AS v',
        rowMode: 'array',
        values: [circular],
        types: goodTypes,
      });
      const failure = await settledOrPending(
        failing.then(
          () => 'resolved' as const,
          (err: unknown) => err,
        ),
        1_500,
      );
      // The serialization error's exact shape is the serializer's to choose —
      // only "rejects with an Error" is pinned, not its message.
      expect(failure).not.toBe('pending');
      expect(failure).not.toBe('resolved');
      expect(failure).toBeInstanceOf(Error);

      a.release();
      aReleased = true;

      const sibling = b.query<{ ok: number }>('SELECT 1 AS ok');
      sibling.catch(() => {});
      const outcome = await settledOrPending(sibling, 1_500);
      expect(outcome).not.toBe('pending');
      if (outcome !== 'pending') expect(outcome.rows[0]?.ok).toBe(1);

      await flushWarnings();
      expect(warnings).toHaveLength(1);
    } finally {
      stop();
      if (a && !aReleased) a.release();
      b?.release();
      await pglite.query('ROLLBACK').catch(() => {});
      await endPoolAndClose(pool);
    }
  });
});
