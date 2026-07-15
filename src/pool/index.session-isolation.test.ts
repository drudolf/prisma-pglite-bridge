import type pg from 'pg';
import Cursor from 'pg-cursor';
import { describe, expect, it } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import type { TelemetrySink } from '../telemetry/bridge-stats.ts';
import { PgBridgePool } from './index.ts';

// Red-phase TDD spec for the session-lock admission-reservation change
// (design: .claude/plans/session-lock-admission-reservation.md, Test plan §A/§C).
//
// Today `SessionLock.acquire` passes every client while `owner` is unset, and
// `updateStatus('T'|'E')` UNCONDITIONALLY reassigns ownership. Between a
// client's admission and its ReadyForQuery lies its whole runExclusive queue
// wait plus WASM execution, so a sibling admitted in that window can execute
// INSIDE another client's transaction and then STEAL ownership on its own RFQ.
//
// The fix makes admission take ownership (acquire-takes), deletes the
// updateStatus steal arm, and removes `hold()` (admission subsumes it). These
// tests assert the post-fix contract; A1/A2/C are RED until the production
// change lands, A3/A5 are GREEN pins that must survive the change.
//
// One shared PGlite for the whole describe (a cold boot per test is ~1.3s).
// Each test builds its own pool (its own SessionLock), so no lock state leaks;
// the afterEach returns the shared session to a clean slate. `reset: false` —
// the reset must run AFTER each test's pool has fully torn down.
const pglite = await setupPGlite({ reset: false });

describe('PgBridgePool — session isolation (admission reservation)', () => {
  // Bounded blocked-promise detection: resolves to the settled value if `p`
  // settles first, else the sentinel `'pending'` after `ms`. The loser timer
  // is unref'd so it never keeps the event loop alive after `p` wins. Copied
  // from the abandoned-transaction / fast-query suites.
  const settledOrPending = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> =>
    Promise.race([
      p,
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), ms).unref();
      }),
    ]);

  // Teardown for a pool over the shared PGlite. After `pool.end()` resolves,
  // an abandoned client's `_destroy` ROLLBACK can still be settling inside
  // PGlite's WASM `runExclusive`; a direct query serializes behind it, so it
  // is a deterministic barrier (not a timing race) before the afterEach reset.
  // The instance is NOT closed here — it is shared across the describe and
  // closed once by setupPGlite's afterAll. The bounded end() lets a genuine
  // SessionLock wedge fail the test instead of hanging the worker.
  const endPoolAndClose = async (pool: PgBridgePool): Promise<void> => {
    await settledOrPending(pool.end(), 10_000).catch(() => {});
    await pglite.query('SELECT 1').catch(() => {});
  };

  // Capture PGliteBridgeAbandonedTransactionWarning emissions by name, exactly
  // like the abandoned-transaction suite. process.emitWarning delivers on a
  // later tick, so callers await flushWarnings before asserting.
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

  // Return the shared session to a clean slate between tests. A defensive
  // ROLLBACK (swallowed) guarantees no open transaction survives a red run
  // that left the session in 'T'/'E'; DISCARD ALL also CLOSEs any suspended
  // portal a cursor left open and DEALLOCATEs every named statement.
  const resetSharedSession = async (): Promise<void> => {
    await pglite.query('ROLLBACK').catch(() => {});
    const { rows } = await pglite.query<{ t: string }>(
      "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'",
    );
    for (const { t } of rows) {
      await pglite.exec(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
    await pglite.exec('DISCARD ALL');
  };

  // ─── A1: queue-window interleave (the probe) ───

  it('A1 (RED): a sibling INSERT survives a foreign ROLLBACK — no steal, no lost write, no misattributed warning', async () => {
    // Choreography (settle-safe on BOTH sides of the fix): C occupies
    // runExclusive with a non-transactional pg_sleep. While C executes, A
    // issues BEGIN and B issues INSERT — both admitted against the unset owner
    // today. A then ROLLBACKs. Pre-fix: B's INSERT ran inside A's transaction
    // and B's RFQ 'T' stole ownership, so A's ROLLBACK blocks (sentinel fires),
    // B's release fires the abandoned-tx ROLLBACK that destroys the shared
    // transaction (final count 0) and misattributes a warning to B. Post-fix:
    // admission serializes A then B; B's INSERT commits standalone (count 1),
    // A's ROLLBACK settles, and B never "owns" a transaction it never began.
    const pool = new PgBridgePool({ pglite, max: 3 });
    const { warnings, stop } = captureAbandonWarnings();
    await pglite.exec('CREATE TABLE a1_iso (id serial PRIMARY KEY, val text)');

    let c: pg.PoolClient | undefined;
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    let bReleased = false;
    try {
      c = await pool.connect();
      a = await pool.connect();
      b = await pool.connect();

      // C occupies runExclusive (non-transactional). Not awaited.
      const slow = c.query('SELECT pg_sleep(0.2)');
      slow.catch(() => {});
      // Let C reach execution so A and B are admitted during its WASM run.
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Both issued in the window, neither awaited.
      const begin = a.query('BEGIN');
      begin.catch(() => {});
      const insert = b.query("INSERT INTO a1_iso (val) VALUES ('b-row')");
      insert.catch(() => {});

      await begin;

      // A's ROLLBACK raced against a 400 ms sentinel. Pre-fix ownership was
      // stolen by B, so A's ROLLBACK cannot proceed and this stays 'pending'
      // until b.release() below unwedges it.
      const rollback = a.query('ROLLBACK');
      rollback.catch(() => {});
      const rbState = await settledOrPending(rollback, 400);

      // Pre-fix B's INSERT already resolved (it ran inside A's tx); post-fix it
      // resolves once A's idle RFQ drains B and B's standalone INSERT runs.
      await insert;

      // Pre-fix: unwedges the stolen ownership via the abandoned-tx
      // rollback-on-release (which destroys A's transaction, discarding B's
      // committed row). Post-fix: a benign release of a clean client.
      b.release();
      bReleased = true;

      await rollback.catch(() => {});
      await slow.catch(() => {});
      await flushWarnings();

      // Assertion 1 — the ROLLBACK settled (pre-fix FAILS: 'pending', stolen).
      expect(rbState).not.toBe('pending');

      // Assertion 2 — B's committed row survived A's rollback (pre-fix FAILS:
      // count 0, B's resolved insert was destroyed by the abandoned-tx
      // rollback fired on b.release()).
      const { rows } = await pglite.query<{ n: string }>('SELECT count(*)::text AS n FROM a1_iso');
      expect(rows[0]?.n).toBe('1');

      // Assertion 3 — no abandoned-transaction warning for B's release (pre-fix
      // FAILS: B "owns" a transaction it never began, so its release warns).
      expect(warnings).toHaveLength(0);
    } finally {
      stop();
      // Red-phase recovery: clear any leaked 'T' directly on the shared
      // session so a red run cannot poison later tests; then release clients.
      await pglite.query('ROLLBACK').catch(() => {});
      if (b !== undefined && !bReleased) b.release();
      a?.release();
      c?.release();
      await endPoolAndClose(pool);
      await resetSharedSession();
    }
  });

  // ─── A2: no execution inside a foreign transaction ───

  it('A2 (RED): a mid-transaction read from the owner sees the queued sibling has not executed inside its tx', async () => {
    // Same C-gate choreography. After A's BEGIN is admitted and executing, A
    // runs a mid-transaction `SELECT count(*)` raced against a 400 ms sentinel.
    // Post-fix: it resolves with count 0 (B is queued, nothing ran inside A's
    // tx). Pre-fix: either resolves with count 1 (B's insert executed inside
    // A's transaction) or stays 'pending' (ownership already stolen) — both
    // fail the single assertion "raced mid-tx read resolved with 0".
    const pool = new PgBridgePool({ pglite, max: 3 });
    await pglite.exec('CREATE TABLE a2_iso (id serial PRIMARY KEY, val text)');

    let c: pg.PoolClient | undefined;
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    let bReleased = false;
    try {
      c = await pool.connect();
      a = await pool.connect();
      b = await pool.connect();

      const slow = c.query('SELECT pg_sleep(0.2)');
      slow.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));

      const begin = a.query('BEGIN');
      begin.catch(() => {});
      const insert = b.query("INSERT INTO a2_iso (val) VALUES ('b-row')");
      insert.catch(() => {});

      await begin;

      // The single discriminating assertion: A's own mid-transaction read must
      // settle with count 0 — B's INSERT did not run inside A's transaction.
      const midRead = await settledOrPending(
        a.query<{ n: string }>('SELECT count(*)::text AS n FROM a2_iso'),
        400,
      );
      expect(midRead).not.toBe('pending');
      expect((midRead as pg.QueryResult<{ n: string }>).rows[0]?.n).toBe('0');

      // Roll A back (raced + settle-safe with the same unwedge discipline as
      // A1), then let everything settle.
      const rollback = a.query('ROLLBACK');
      rollback.catch(() => {});
      await settledOrPending(rollback, 400);
      await insert;
      b.release();
      bReleased = true;
      await rollback.catch(() => {});
      await slow.catch(() => {});

      // Final count 1 — B's INSERT committed standalone after A rolled back.
      const { rows } = await pglite.query<{ n: string }>('SELECT count(*)::text AS n FROM a2_iso');
      expect(rows[0]?.n).toBe('1');
    } finally {
      await pglite.query('ROLLBACK').catch(() => {});
      if (b !== undefined && !bReleased) b.release();
      a?.release();
      c?.release();
      await endPoolAndClose(pool);
      await resetSharedSession();
    }
  });

  // ─── A3: same-tick two-client choreography (GREEN pin) ───

  it('A3 (GREEN): same-tick BEGIN and INSERT with no C gate — the sibling INSERT survives the rollback', async () => {
    // No C gate: a.query('BEGIN') and b.query('INSERT') are issued in the same
    // tick, then A is rolled back and B awaited. This already passes today on
    // the observed interleaving (B's admission lands after A's round trip);
    // pin it so both admission orders hold under the fix. Count is 1 and the
    // rollback is not pending.
    const pool = new PgBridgePool({ pglite, max: 2 });
    await pglite.exec('CREATE TABLE a3_iso (id serial PRIMARY KEY, val text)');

    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    let bReleased = false;
    try {
      a = await pool.connect();
      b = await pool.connect();

      const begin = a.query('BEGIN');
      begin.catch(() => {});
      const insert = b.query("INSERT INTO a3_iso (val) VALUES ('b-row')");
      insert.catch(() => {});

      await begin;

      const rollback = a.query('ROLLBACK');
      rollback.catch(() => {});
      const rbState = await settledOrPending(rollback, 1_500);
      await insert;
      b.release();
      bReleased = true;
      await rollback.catch(() => {});

      expect(rbState).not.toBe('pending');
      const { rows } = await pglite.query<{ n: string }>('SELECT count(*)::text AS n FROM a3_iso');
      expect(rows[0]?.n).toBe('1');
    } finally {
      await pglite.query('ROLLBACK').catch(() => {});
      if (b !== undefined && !bReleased) b.release();
      a?.release();
      await endPoolAndClose(pool);
      await resetSharedSession();
    }
  });

  // ─── A5: suspended portal owns the session between batches (GREEN pin) ───

  it('A5 (GREEN): a suspended portal owns the session between cursor batches — a sibling query stays queued until the cursor finishes', async () => {
    // A on a max:2 pool opens a pg-cursor and reads a first batch, leaving the
    // portal suspended between execProtocolRawStream calls. A sibling B's query
    // must stay 'pending' while the portal is suspended (A owns the session),
    // then resolve once the cursor is closed. Green today (hold() provides
    // ownership at the flush boundary) and must stay green when hold() is
    // deleted (admission provides it).
    const pool = new PgBridgePool({ pglite, max: 2 });
    await pglite.exec('CREATE TABLE a5_iso AS SELECT g AS i FROM generate_series(1, 50) g');

    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();

      const cursor = a.query(new Cursor<{ i: number }>('SELECT i FROM a5_iso ORDER BY i'));
      const firstBatch = await cursor.read(5);
      expect(firstBatch).toHaveLength(5);

      // Sibling probe: while the portal is suspended, B's query is queued
      // behind A's session ownership. Race a short sentinel — it must win.
      const probe = b.query<{ one: number }>('SELECT 1 AS one');
      probe.catch(() => {});
      const whileSuspended = await settledOrPending(probe, 300);
      expect(whileSuspended).toBe('pending');

      // Finish and close the cursor — the terminating Sync releases the
      // session. B's query then resolves.
      await new Promise<void>((resolve, reject) => {
        cursor.close((err?: Error) => (err ? reject(err) : resolve()));
      });

      const afterClose = await settledOrPending(probe, 1_500);
      expect(afterClose).not.toBe('pending');
      expect((afterClose as pg.QueryResult<{ one: number }>).rows[0]?.one).toBe(1);
    } finally {
      await pglite.query('ROLLBACK').catch(() => {});
      a?.release();
      b?.release();
      await endPoolAndClose(pool);
      await resetSharedSession();
    }
  });

  // ─── portalSuspended lifecycle (tribunal amendment condition) ───

  it('portalSuspended lifecycle: abandon mid-portal → sibling admission → recycled reuse → fresh cursor', async () => {
    // Adversarial pass over the flag's set/clear sites: a clean flush
    // boundary SETS it, the release-path recovery is GATED on it (only a
    // genuinely suspended portal earns the manufactured Sync), and any real
    // RFQ CLEARS it — so a recycled client must serve normal queries with no
    // spurious recovery on later releases, and a fresh cursor must set and
    // clear it again cleanly while a sibling races admissions throughout.
    const pool = new PgBridgePool({ pglite, max: 2 });
    await pglite.exec('CREATE TABLE flag_iso AS SELECT g AS i FROM generate_series(1, 50) g');

    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    let recycled: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();

      // Suspend a portal on A (flag set); queue a sibling behind ownership.
      const cursor = a.query(new Cursor<{ i: number }>('SELECT i FROM flag_iso ORDER BY i'));
      expect(await cursor.read(5)).toHaveLength(5);
      const probe = b.query<{ one: number }>('SELECT 1 AS one');
      probe.catch(() => {});
      expect(await settledOrPending(probe, 300)).toBe('pending');

      // Abandon mid-portal: the flag-gated recovery DELIVERS the Sync to pg
      // (not discarded) and releases ownership — the queued sibling drains AND
      // the abandoned cursor completes on the delivered RFQ, so pg's
      // activeQuery clears and the client is usable when the pool recycles it.
      a.release();
      a = undefined;
      const afterAbandon = await settledOrPending(probe, 1_500);
      expect(afterAbandon).not.toBe('pending');
      expect((afterAbandon as pg.QueryResult<{ one: number }>).rows[0]?.one).toBe(1);

      // Recycled reuse (delivered recovery): pg-pool hands the recycled A
      // client back on the next checkout; a query on it must SETTLE with
      // correct rows. Pre-fix this wedged ('pending') — the discarded Sync left
      // pg's activeQuery pointing at the dead cursor. Sentinel-raced so a
      // pre-fix wedge fails fast.
      recycled = await pool.connect();
      const reused = await settledOrPending(
        recycled.query<{ four: number }>('SELECT 4 AS four'),
        1_500,
      );
      expect(reused).not.toBe('pending');
      expect((reused as pg.QueryResult<{ four: number }>).rows[0]?.four).toBe(4);
      recycled.release();
      recycled = undefined;

      // The sibling's own flag transitions: a normal query (flag never set →
      // RFQ keeps it clear), then a fresh cursor — flag sets at the flush
      // boundary and clears through the orderly close's Sync RFQ — then a
      // final normal query proving the session is genuinely idle and owned
      // by nobody.
      const again = await b.query<{ two: number }>('SELECT 2 AS two');
      expect(again.rows[0]?.two).toBe(2);

      const cursor2 = b.query(new Cursor<{ i: number }>('SELECT i FROM flag_iso ORDER BY i'));
      expect(await cursor2.read(3)).toHaveLength(3);
      await new Promise<void>((resolve, reject) => {
        cursor2.close((err?: Error) => (err ? reject(err) : resolve()));
      });

      const finalProbe = await b.query<{ three: number }>('SELECT 3 AS three');
      expect(finalProbe.rows[0]?.three).toBe(3);
    } finally {
      await pglite.query('ROLLBACK').catch(() => {});
      a?.release();
      recycled?.release();
      b?.release();
      await endPoolAndClose(pool);
      await resetSharedSession();
    }
  });

  // ─── max: 1 reuse during in-flight recovery (tribunal MEDIUM) ───

  it('max: 1 (RED): the sole client is usable again after a non-tx abandoned-cursor release', async () => {
    // No SessionLock exists at max: 1, so recovery cannot ride the lock — the
    // delivered Sync's serialization comes from runExclusive alone. Abandon a
    // cursor on the sole client, release, then immediately re-checkout (pg-pool
    // hands back the SAME recycled client) and query. Post-fix it settles with
    // correct rows: the new borrower's first query serializes behind the
    // in-flight delivery via runExclusive, and the delivered RFQ has completed
    // the abandoned cursor so pg's activeQuery is clear. Pre-fix the recycled
    // client is wedged ('pending', probe-recorded) — the discarded Sync left
    // pg's activeQuery pointing at the dead cursor. If the in-flight overlap is
    // not deterministically observable, the settle assertion alone is the test:
    // it is RED pre-fix regardless, because the recycled client is wedged.
    const pool = new PgBridgePool({ pglite, max: 1 });
    await pglite.exec('CREATE TABLE m1_recov AS SELECT g AS i FROM generate_series(1, 50) g');

    let next: pg.PoolClient | undefined;
    try {
      const a = await pool.connect();
      const cursor = a.query(new Cursor<{ i: number }>('SELECT i FROM m1_recov ORDER BY i'));
      expect(await cursor.read(5)).toHaveLength(5);
      // Release, then IMMEDIATELY re-checkout — no await between, so the new
      // borrower's admission overlaps the in-flight recovery delivery.
      a.release();

      next = await pool.connect();
      const reused = await settledOrPending(
        next.query<{ five: number }>('SELECT 5 AS five'),
        1_500,
      );
      expect(reused).not.toBe('pending');
      expect((reused as pg.QueryResult<{ five: number }>).rows[0]?.five).toBe(5);
    } finally {
      await pglite.query('ROLLBACK').catch(() => {});
      next?.release();
      await endPoolAndClose(pool);
      await resetSharedSession();
    }
  });

  // ─── C: telemetry pin ───

  it('C (RED): a client queued behind a sibling admission records a non-zero lockWait', async () => {
    // With a telemetry sink present, runWithTiming records the acquire wait.
    // Determinism requires TWO things a naive same-tick pg_sleep choreography
    // cannot give: A must be admitted BEFORE B (same-tick admission order is
    // a microtask race), and the wait must elapse with a FREE event loop
    // (PGlite executes on the JS thread, so WASM sleep would starve the
    // measurement path's timers/microtasks scheduling). Gate with
    // pglite.runExclusive held over a pure JS await: A is admitted (takes
    // lock ownership) and its op queues behind the gate; deterministic JS
    // delays then order B's admission behind A's lock ownership; B's acquire
    // waits until A's idle RFQ after the gate releases.
    const lockWaits: number[] = [];
    const telemetry: TelemetrySink = {
      recordQuery: () => {},
      recordLockWait: (durationMs: number) => {
        lockWaits.push(durationMs);
      },
    };
    const pool = new PgBridgePool({ pglite, max: 2, telemetry });

    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();

      let releaseGate!: () => void;
      const gateHeld = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const gate = pglite.runExclusive(async () => {
        await gateHeld;
      });
      // Let the gate take the runExclusive mutex.
      await new Promise((resolve) => setTimeout(resolve, 10));

      // A is admitted (takes lock ownership); its op queues behind the gate.
      const slow = a.query('SELECT 1 AS a_gated');
      await new Promise((resolve) => setTimeout(resolve, 10));
      // B's acquire now queues behind A's lock ownership. Post-fix it waits
      // until A's idle RFQ; pre-fix it is admitted immediately (owner unset),
      // so every recorded lock wait is ~0 → RED.
      const fast = b.query('SELECT 1 AS b_queued');
      await new Promise((resolve) => setTimeout(resolve, 30));
      releaseGate();
      await gate;
      await Promise.all([slow, fast]);

      // At least one recorded lock wait must reflect B queueing behind A's
      // admission for the >= 30 ms the gate was held after B's issuance.
      expect(lockWaits.some((ms) => ms >= 5)).toBe(true);
    } finally {
      a?.release();
      b?.release();
      await endPoolAndClose(pool);
      await resetSharedSession();
    }
  });
});
