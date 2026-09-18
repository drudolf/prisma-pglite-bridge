import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMockPGlite } from '../__tests__/mocks.ts';
import { setupPGlite } from '../__tests__/pglite.ts';
import { PgBridgeError } from '../errors.ts';
import { SnapshotManager } from './snapshot-manager.ts';

const pglite = await setupPGlite();

describe('snapshot manager', () => {
  it('rolls back and drops the staging schema if snapshot creation fails', async () => {
    const error = new Error('boom');
    const pglite = createMockPGlite({ query: vi.fn().mockRejectedValue(error) });

    const snapshot = new SnapshotManager(pglite);

    await expect(snapshot.snapshotDb()).rejects.toThrow(error);
    expect(vi.mocked(pglite.exec).mock.calls).toEqual([
      [`DROP SCHEMA IF EXISTS "_pglite_snapshot_new" CASCADE`],
      ['BEGIN'],
      [`CREATE SCHEMA "_pglite_snapshot_new"`],
      ['ROLLBACK'],
      [`DROP SCHEMA IF EXISTS "_pglite_snapshot_new" CASCADE`],
    ]);
  });

  it('restores snapshot contents and sequence state during resetDb', async () => {
    await pglite.exec(
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL); INSERT INTO users (name) VALUES ('alice')",
    );

    const snapshot = new SnapshotManager(pglite);
    await snapshot.snapshotDb();

    await pglite.exec(`INSERT INTO users (name) VALUES ('bob')`);
    await snapshot.resetDb();

    const { rows: restoredRows } = await pglite.query<{ id: number; name: string }>(
      'SELECT id, name FROM users ORDER BY id',
    );
    expect(restoredRows).toEqual([{ id: 1, name: 'alice' }]);

    const { rows: nextRow } = await pglite.query<{ id: number }>(
      `INSERT INTO users (name) VALUES ('carol') RETURNING id`,
    );
    expect(nextRow[0]?.id).toBe(2);

    await pglite.exec('DROP TABLE users');
  });

  it('survives a table name containing a double quote', async () => {
    await pglite.exec(
      `CREATE TABLE "odd""name" (id serial PRIMARY KEY, v text); INSERT INTO "odd""name" (v) VALUES ('seed')`,
    );

    const snapshot = new SnapshotManager(pglite);
    await snapshot.snapshotDb();
    await pglite.exec(`INSERT INTO "odd""name" (v) VALUES ('extra')`);
    await snapshot.resetDb();

    const { rows } = await pglite.query<{ v: string }>(`SELECT v FROM "odd""name" ORDER BY id`);
    expect(rows).toEqual([{ v: 'seed' }]);

    await pglite.exec(`DROP TABLE "odd""name"`);
  });

  it('resetDb leaves a leftover staging schema untouched (crash-recovery state)', async () => {
    // Defended-against state: a hard crash mid-snapshotDb on a persisted
    // dataDir leaves `_pglite_snapshot_new` behind (the next snapshotDb
    // pre-drops it). Until then, resetDb must not treat the staging tables
    // as user data — truncating them would destroy the very state the
    // pre-drop defense exists for.
    await pglite.exec(
      `CREATE SCHEMA "_pglite_snapshot_new";
       CREATE TABLE "_pglite_snapshot_new".staged (id int);
       INSERT INTO "_pglite_snapshot_new".staged VALUES (1);
       CREATE TABLE staging_user_t (id int);
       INSERT INTO staging_user_t VALUES (1)`,
    );
    const snapshot = new SnapshotManager(pglite);
    try {
      await snapshot.resetDb();

      const { rows: user } = await pglite.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM staging_user_t',
      );
      expect(user[0]?.count).toBe('0');

      const { rows: staged } = await pglite.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM "_pglite_snapshot_new".staged',
      );
      expect(staged[0]?.count).toBe('1');
    } finally {
      await pglite.exec(
        `DROP SCHEMA IF EXISTS "_pglite_snapshot_new" CASCADE;
         DROP TABLE IF EXISTS staging_user_t`,
      );
    }
  });

  it('drops the stored snapshot so resetDb truncates to empty again', async () => {
    await pglite.exec(
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL); INSERT INTO users (name) VALUES ('alice')",
    );

    const snapshot = new SnapshotManager(pglite);
    await snapshot.snapshotDb();
    await snapshot.resetSnapshot();

    await pglite.exec(`INSERT INTO users (name) VALUES ('bob')`);
    await snapshot.resetDb();

    const { rows: rowsAfterReset } = await pglite.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM users',
    );
    expect(rowsAfterReset[0]?.count).toBe('0');

    const { rows: nextRow } = await pglite.query<{ id: number }>(
      `INSERT INTO users (name) VALUES ('carol') RETURNING id`,
    );
    expect(nextRow[0]?.id).toBe(1);

    await pglite.exec('DROP TABLE users');
  });

  it('skips the transaction and resets session state without deallocating statements when no user table exists', async () => {
    const pglite = createMockPGlite();

    const snapshot = new SnapshotManager(pglite);

    await snapshot.resetDb();

    const execCalls = vi.mocked(pglite.exec).mock.calls.map((call) => String(call[0]));
    // No user table → nothing to truncate → no transaction at all; the
    // session scrub is the only statement issued.
    expect(execCalls).toHaveLength(1);
    const executed = execCalls[0] ?? '';
    expect(executed).not.toContain('BEGIN');
    expect(executed).not.toContain('COMMIT');
    expect(executed).not.toContain('TRUNCATE');
    // Granular equivalent of DISCARD ALL minus DEALLOCATE ALL: session vars
    // reset, temp tables and plans discarded — prepared statements survive.
    expect(executed).toContain('CLOSE ALL');
    expect(executed).toContain('SET SESSION AUTHORIZATION DEFAULT');
    expect(executed).toContain('RESET ALL');
    expect(executed).toContain('UNLISTEN *');
    expect(executed).toContain('pg_advisory_unlock_all()');
    expect(executed).toContain('DISCARD PLANS');
    expect(executed).toContain('DISCARD SEQUENCES');
    expect(executed).toContain('DISCARD TEMP');
    expect(executed).not.toContain('DEALLOCATE');
    expect(executed).not.toContain('DISCARD ALL');
    // Snapshot-presence probe + user-table listing; no restore plan without
    // a snapshot schema.
    const sqls = vi.mocked(pglite.query).mock.calls.map((call) => String(call[0]));
    expect(sqls).toHaveLength(2);
    expect(sqls[0]).toContain('to_regnamespace');
    expect(sqls[1]).toContain('pg_tables');
  });

  it('resetDb({ scrubSession: false }) leaves the session settings of a real PGlite untouched', async () => {
    // A user table forces the truncate/restore transaction (with its
    // SET LOCAL inside); a session-level SET there would leak past COMMIT.
    await pglite.exec('CREATE TABLE keep_settings_t (id int)');
    await pglite.exec(`SET application_name = 'keep'; SET session_replication_role = origin`);
    try {
      const snapshot = new SnapshotManager(pglite);
      await snapshot.resetDb({ scrubSession: false });

      const { rows } = await pglite.query<{ app: string; role: string }>(
        `SELECT current_setting('application_name') AS app,
                current_setting('session_replication_role') AS role`,
      );
      expect(rows).toEqual([{ app: 'keep', role: 'origin' }]);
    } finally {
      await pglite.exec('RESET ALL; DROP TABLE keep_settings_t');
    }
  });

  it('two managers over one PGlite agree on snapshot presence', async () => {
    await pglite.exec(
      `CREATE TABLE shared_mgr_t (id serial PRIMARY KEY, v text);
       INSERT INTO shared_mgr_t (v) VALUES ('seed')`,
    );
    try {
      const a = new SnapshotManager(pglite);
      const b = new SnapshotManager(pglite);

      // A's snapshot is visible to B: B restores the seed row.
      await a.snapshotDb();
      await pglite.exec(`INSERT INTO shared_mgr_t (v) VALUES ('extra')`);
      await b.resetDb();
      const { rows: restored } = await pglite.query<{ v: string }>(
        'SELECT v FROM shared_mgr_t ORDER BY id',
      );
      expect(restored).toEqual([{ v: 'seed' }]);

      // B's resetSnapshot is visible to A: A truncates to empty.
      await b.resetSnapshot();
      await a.resetDb();
      const { rows: truncated } = await pglite.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM shared_mgr_t',
      );
      expect(truncated[0]?.count).toBe('0');
    } finally {
      await pglite.exec(
        'DROP SCHEMA IF EXISTS "_pglite_snapshot" CASCADE; DROP TABLE shared_mgr_t',
      );
    }
  });

  it('excludes _prisma% tables by escaped LIKE — xprisma_data is a user table', async () => {
    // `_` is a LIKE wildcard: an unescaped '_prisma%' also matches
    // 'xprisma_data'. The escaped '\_prisma%' pattern must exclude only a
    // literal leading underscore.
    await pglite.exec(
      `CREATE TABLE _prisma_migrations (id int);
       CREATE TABLE xprisma_data (id int);
       INSERT INTO _prisma_migrations VALUES (1);
       INSERT INTO xprisma_data VALUES (1)`,
    );
    try {
      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      const { rows: captured } = await pglite.query<{ source_table: string }>(
        'SELECT source_table FROM "_pglite_snapshot".__tables ORDER BY source_table',
      );
      expect(captured).toEqual([{ source_table: 'xprisma_data' }]);

      await pglite.exec(
        'INSERT INTO _prisma_migrations VALUES (2); INSERT INTO xprisma_data VALUES (2)',
      );
      await snapshot.resetDb();

      const counts = async (): Promise<{ migrations: string; data: string }> => {
        const { rows } = await pglite.query<{ migrations: string; data: string }>(
          `SELECT (SELECT count(*)::text FROM _prisma_migrations) AS migrations,
                  (SELECT count(*)::text FROM xprisma_data) AS data`,
        );
        return rows[0] ?? { migrations: '?', data: '?' };
      };
      // _prisma_migrations untouched (2 rows); xprisma_data restored to the seed.
      expect(await counts()).toEqual({ migrations: '2', data: '1' });

      await snapshot.resetSnapshot();
      await snapshot.resetDb();
      // Still untouched; xprisma_data truncated.
      expect(await counts()).toEqual({ migrations: '2', data: '0' });
    } finally {
      await pglite.exec(
        'DROP SCHEMA IF EXISTS "_pglite_snapshot" CASCADE; DROP TABLE _prisma_migrations, xprisma_data',
      );
    }
  });

  it('keeps named prepared statements usable across resetDb', async () => {
    await pglite.exec('PREPARE snapshot_manager_probe AS SELECT 42 AS answer');

    const snapshot = new SnapshotManager(pglite);
    await snapshot.resetDb();

    const { rows } = await pglite.query<{ answer: number }>('EXECUTE snapshot_manager_probe');
    expect(rows).toEqual([{ answer: 42 }]);

    await pglite.exec('DEALLOCATE snapshot_manager_probe');
  });

  describe('identity and generated columns', () => {
    // Failing tests leave their tables behind (the throw happens before any
    // inline cleanup), so drop everything unconditionally — a lingering
    // GENERATED ALWAYS table would poison every later resetDb in this file.
    afterEach(async () => {
      await pglite.exec(
        `DROP SCHEMA IF EXISTS "_pglite_snapshot" CASCADE;
         DROP TABLE IF EXISTS ident_always, gen_stored, ident_default, zc, mixed_ident, snap_dropped, snap_kept, col_dropped, quoted_col_dropped`,
      );
    });

    it('restores a table with a GENERATED ALWAYS AS IDENTITY column, keeping seed ids and sequence position', async () => {
      await pglite.exec(
        `CREATE TABLE ident_always (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text);
         INSERT INTO ident_always (v) VALUES ('a'), ('b')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec(
        `INSERT INTO ident_always (v) VALUES ('c');
         UPDATE ident_always SET v = 'mutated' WHERE id = 1`,
      );
      await snapshot.resetDb();

      const { rows } = await pglite.query<{ id: number; v: string }>(
        'SELECT id, v FROM ident_always ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 1, v: 'a' },
        { id: 2, v: 'b' },
      ]);

      const { rows: nextRow } = await pglite.query<{ id: number }>(
        `INSERT INTO ident_always (v) VALUES ('z') RETURNING id`,
      );
      expect(nextRow[0]?.id).toBe(3);
    });

    it('restores a table with a stored generated column by recomputing it', async () => {
      await pglite.exec(
        `CREATE TABLE gen_stored (a int, b int GENERATED ALWAYS AS (a * 2) STORED);
         INSERT INTO gen_stored (a) VALUES (1), (2)`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec(
        `INSERT INTO gen_stored (a) VALUES (5);
         UPDATE gen_stored SET a = 10 WHERE a = 1`,
      );
      await snapshot.resetDb();

      const { rows } = await pglite.query<{ a: number; b: number }>(
        'SELECT a, b FROM gen_stored ORDER BY a',
      );
      expect(rows).toEqual([
        { a: 1, b: 2 },
        { a: 2, b: 4 },
      ]);
    });

    // Regression guard — BY DEFAULT identity already works with the current
    // SELECT * restore; this pins the behavior while the restore is rewritten.
    it('restores a table with a GENERATED BY DEFAULT AS IDENTITY column', async () => {
      await pglite.exec(
        `CREATE TABLE ident_default (id int GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, v text);
         INSERT INTO ident_default (v) VALUES ('a'), ('b')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec(
        `INSERT INTO ident_default (v) VALUES ('c');
         UPDATE ident_default SET v = 'mutated' WHERE id = 2`,
      );
      await snapshot.resetDb();

      const { rows } = await pglite.query<{ id: number; v: string }>(
        'SELECT id, v FROM ident_default ORDER BY id',
      );
      expect(rows).toEqual([
        { id: 1, v: 'a' },
        { id: 2, v: 'b' },
      ]);

      const { rows: nextRow } = await pglite.query<{ id: number }>(
        `INSERT INTO ident_default (v) VALUES ('z') RETURNING id`,
      );
      expect(nextRow[0]?.id).toBe(3);
    });

    // Regression guard — zero-column tables restore fine today; after the fix
    // this exercises the SELECT * fallback branch (no column list to build).
    it('restores a zero-column table', async () => {
      await pglite.exec('CREATE TABLE zc()');
      await pglite.exec('INSERT INTO zc DEFAULT VALUES');
      await pglite.exec('INSERT INTO zc DEFAULT VALUES');

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec('INSERT INTO zc DEFAULT VALUES');
      await snapshot.resetDb();

      const { rows } = await pglite.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM zc',
      );
      expect(rows[0]?.count).toBe('2');
    });

    it('restores a table mixing ALWAYS and BY DEFAULT identity columns', async () => {
      await pglite.exec(
        `CREATE TABLE mixed_ident (i1 int GENERATED ALWAYS AS IDENTITY, i2 int GENERATED BY DEFAULT AS IDENTITY, v text);
         INSERT INTO mixed_ident (v) VALUES ('a'), ('b')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec(
        `INSERT INTO mixed_ident (v) VALUES ('c');
         UPDATE mixed_ident SET v = 'mutated' WHERE i1 = 1`,
      );
      await snapshot.resetDb();

      const { rows } = await pglite.query<{ i1: number; i2: number; v: string }>(
        'SELECT i1, i2, v FROM mixed_ident ORDER BY i1',
      );
      expect(rows).toEqual([
        { i1: 1, i2: 1, v: 'a' },
        { i1: 2, i2: 2, v: 'b' },
      ]);
    });

    it('rejects resetDb with an explicit error when a snapshotted table no longer exists', async () => {
      // A second, surviving table keeps the table list non-empty so resetDb
      // actually reaches the restore loop instead of short-circuiting.
      await pglite.exec(
        `CREATE TABLE snap_kept (id int);
         CREATE TABLE snap_dropped (id int, v text);
         INSERT INTO snap_dropped VALUES (1, 'a')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec('DROP TABLE snap_dropped');

      const error = await snapshot.resetDb().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('public.snap_dropped');
      expect((error as Error).message).toContain('no longer exists');
    });

    it('fails fast even when every snapshotted table was dropped', async () => {
      // Isolated instance: with the shared fixture, tables from other tests
      // keep pg_tables non-empty, and this case is exactly about resetDb
      // finding no live user tables at all.
      const iso = new PGlite();
      try {
        await iso.exec(`CREATE TABLE only_t (id int); INSERT INTO only_t VALUES (1)`);

        const snapshot = new SnapshotManager(iso);
        await snapshot.snapshotDb();

        await iso.exec('DROP TABLE only_t');

        const error = await snapshot.resetDb().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('public.only_t');
        expect((error as Error).message).toContain('no longer exists');
      } finally {
        await iso.close();
      }
    });

    it('fails fast when a snapshotted column was dropped', async () => {
      await pglite.exec(
        `CREATE TABLE col_dropped (a int, b text);
         INSERT INTO col_dropped VALUES (1, 'x')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec('ALTER TABLE col_dropped DROP COLUMN b');

      const error = await snapshot.resetDb().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      // quote_ident semantics: a plain lowercase column name renders
      // UNQUOTED in the drift message (no decorative quotes).
      expect((error as Error).message).toContain('Snapshot columns b of public.col_dropped');
      expect((error as Error).message).toContain('no longer exist');
    });

    it('escapes a double-quote in a dropped column name in the drift error (quote_ident)', async () => {
      // Column literally named `he"said` — quote_ident renders it with the
      // embedded quote doubled: "he""said". The manual '"' || name || '"'
      // concatenation would emit the unescaped "he"said" instead.
      await pglite.exec(
        `CREATE TABLE quoted_col_dropped (a int, "he""said" text);
         INSERT INTO quoted_col_dropped VALUES (1, 'x')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec(`ALTER TABLE quoted_col_dropped DROP COLUMN "he""said"`);

      const error = await snapshot.resetDb().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('public.quoted_col_dropped');
      expect((error as Error).message).toContain('"he""said"');
      expect((error as Error).message).toContain('no longer exist');
    });
  });

  describe('atomic snapshot rebuild', () => {
    // Restore spies on the shared instance first so cleanup uses the real
    // exec, then drop both snapshot schemas (a failed test leaves the temp
    // schema behind) and every table this block creates.
    afterEach(async () => {
      vi.restoreAllMocks();
      await pglite.exec(
        `DROP SCHEMA IF EXISTS "_pglite_snapshot" CASCADE;
         DROP SCHEMA IF EXISTS "_pglite_snapshot_new" CASCADE;
         DROP TABLE IF EXISTS atomic_t, leftover_t, resnap_t, first_fail_t`,
      );
    });

    it('keeps the previous snapshot restorable when a re-snapshot fails at the schema swap', async () => {
      await pglite.exec(
        `CREATE TABLE atomic_t (id serial PRIMARY KEY, v text);
         INSERT INTO atomic_t (v) VALUES ('seed')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec(`UPDATE atomic_t SET v = 'mutated' WHERE id = 1`);

      // Fail the second snapshot exactly at the swap: the fixed contract
      // renames "_pglite_snapshot_new" into place via ALTER SCHEMA at the end
      // of the rebuild transaction. Today's code never emits ALTER SCHEMA, so
      // the re-snapshot succeeds and the rejects assertion goes red.
      const realExec = pglite.exec.bind(pglite);
      let swapFailed = false;
      const execSpy = vi.spyOn(pglite, 'exec').mockImplementation(async (sql, options) => {
        if (!swapFailed && sql.includes('ALTER SCHEMA')) {
          swapFailed = true;
          throw new Error('swap boom');
        }
        return realExec(sql, options);
      });
      try {
        await expect(snapshot.snapshotDb()).rejects.toThrow('swap boom');
      } finally {
        execSpy.mockRestore();
      }

      // The failed rebuild must not have destroyed the previous snapshot:
      // resetDb restores the original seed rows, not truncate-to-empty.
      await snapshot.resetDb();
      const { rows } = await pglite.query<{ id: number; v: string }>(
        'SELECT id, v FROM atomic_t ORDER BY id',
      );
      expect(rows).toEqual([{ id: 1, v: 'seed' }]);
    });

    it('rolls back and drops only the temp schema when the rebuild fails mid-build', async () => {
      const error = new Error('build boom');
      const exec = vi.fn(async (sql: string) => {
        if (sql.includes('CREATE TABLE') && sql.includes('_pglite_snapshot_new')) throw error;
      });
      const pglite = createMockPGlite({ exec });

      const snapshot = new SnapshotManager(pglite);

      await expect(snapshot.snapshotDb()).rejects.toThrow('build boom');

      const calls = vi.mocked(pglite.exec).mock.calls.map((call) => String(call[0]));

      // Invariants over the call list, not an exact sequence: the failure
      // path rolls back, clears its temp schema, and never touches the
      // previous snapshot inside the rebuild transaction.
      expect(calls.some((sql) => sql.includes('ROLLBACK'))).toBe(true);
      expect(
        calls.some((sql) => sql.includes('DROP SCHEMA IF EXISTS "_pglite_snapshot_new" CASCADE')),
      ).toBe(true);

      const beginIndex = calls.findIndex((sql) => sql.includes('BEGIN'));
      expect(beginIndex).toBeGreaterThanOrEqual(0);
      // Note the closing quote: "_pglite_snapshot" CASCADE cannot match the
      // temp-schema drop "_pglite_snapshot_new" CASCADE.
      expect(
        calls
          .slice(beginIndex + 1)
          .some((sql) => sql.includes('DROP SCHEMA IF EXISTS "_pglite_snapshot" CASCADE')),
      ).toBe(false);
    });

    it('rethrows the original build error even when the rollback itself fails', async () => {
      const buildError = new Error('build boom');
      const rollbackError = new Error('rollback boom');
      const exec = vi.fn(async (sql: string) => {
        if (sql.includes('CREATE SCHEMA')) throw buildError;
        if (sql.includes('ROLLBACK')) throw rollbackError;
      });
      const pglite = createMockPGlite({ exec });

      const snapshot = new SnapshotManager(pglite);

      const error = await snapshot.snapshotDb().then(
        () => null,
        (e: unknown) => e,
      );
      // Cleanup is best-effort: the rollback failure must not mask the
      // original build error. Today the rollback rejection propagates instead.
      expect(error).toBe(buildError);
    });

    it('resetSnapshot drops a leftover temp schema from an interrupted rebuild', async () => {
      await pglite.exec(
        `CREATE TABLE leftover_t (id serial PRIMARY KEY, v text);
         INSERT INTO leftover_t (v) VALUES ('seed')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      // Simulate a build interrupted between CREATE SCHEMA and the swap.
      await pglite.exec('CREATE SCHEMA "_pglite_snapshot_new"');

      await snapshot.resetSnapshot();

      const { rows } = await pglite.query<{ old_exists: boolean; new_exists: boolean }>(
        `SELECT to_regnamespace('_pglite_snapshot') IS NOT NULL AS old_exists,
                to_regnamespace('_pglite_snapshot_new') IS NOT NULL AS new_exists`,
      );
      expect(rows).toEqual([{ old_exists: false, new_exists: false }]);
    });

    it('serializes concurrent snapshotDb calls so their transactions do not interleave', async () => {
      // Every exec takes one full macrotask turn (setTimeout 0), so without a
      // mutex two in-flight snapshotDb calls alternate deterministically:
      // DROP, DROP, BEGIN, BEGIN, ... — the second BEGIN lands before the
      // first COMMIT. With the mutex the second call's transaction may only
      // start after the first call's COMMIT.
      const execLog: string[] = [];
      const exec = vi.fn(async (sql: string) => {
        execLog.push(sql);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      });
      const pglite = createMockPGlite({ exec });

      const snapshot = new SnapshotManager(pglite);

      const first = snapshot.snapshotDb();
      const second = snapshot.snapshotDb();
      await Promise.all([first, second]);

      const beginIndexes = execLog.flatMap((sql, i) => (sql.includes('BEGIN') ? [i] : []));
      const commitIndexes = execLog.flatMap((sql, i) => (sql.includes('COMMIT') ? [i] : []));
      expect(beginIndexes).toHaveLength(2);
      expect(commitIndexes).toHaveLength(2);
      expect(beginIndexes[1]).toBeGreaterThan(commitIndexes[0] ?? Number.POSITIVE_INFINITY);
    });

    // Regression pin — the happy re-snapshot path already works today and
    // must keep working once the rebuild goes through the temp schema.
    it('resetDb restores the newest snapshot after a successful re-snapshot', async () => {
      await pglite.exec(
        `CREATE TABLE resnap_t (id serial PRIMARY KEY, v text);
         INSERT INTO resnap_t (v) VALUES ('a')`,
      );

      const snapshot = new SnapshotManager(pglite);
      await snapshot.snapshotDb();

      await pglite.exec(`UPDATE resnap_t SET v = 'b' WHERE id = 1`);
      await snapshot.snapshotDb();

      await pglite.exec(`INSERT INTO resnap_t (v) VALUES ('junk')`);
      await snapshot.resetDb();

      const { rows } = await pglite.query<{ id: number; v: string }>(
        'SELECT id, v FROM resnap_t ORDER BY id',
      );
      expect(rows).toEqual([{ id: 1, v: 'b' }]);
    });

    // Regression pin — a failing FIRST snapshot never sets #hasSnapshot, so a
    // later resetDb truncates to empty without error (no half-built snapshot
    // is left behind to restore from). Passes today and must keep passing.
    it('leaves resetDb truncating to empty when the first-ever snapshot fails', async () => {
      await pglite.exec(
        `CREATE TABLE first_fail_t (id serial PRIMARY KEY, v text);
         INSERT INTO first_fail_t (v) VALUES ('seed')`,
      );

      const snapshot = new SnapshotManager(pglite);

      // Matches the first CREATE TABLE into the snapshot schema under both
      // the current layout ("_pglite_snapshot".__tables) and the fixed one
      // ("_pglite_snapshot_new".__tables) — '_pglite_snapshot' without the
      // closing quote is a substring of both.
      const realExec = pglite.exec.bind(pglite);
      let failed = false;
      const execSpy = vi.spyOn(pglite, 'exec').mockImplementation(async (sql, options) => {
        if (!failed && sql.includes('CREATE TABLE') && sql.includes('_pglite_snapshot')) {
          failed = true;
          throw new Error('first snapshot boom');
        }
        return realExec(sql, options);
      });
      try {
        await expect(snapshot.snapshotDb()).rejects.toThrow('first snapshot boom');
      } finally {
        execSpy.mockRestore();
      }

      await snapshot.resetDb();

      const { rows } = await pglite.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM first_fail_t',
      );
      expect(rows[0]?.count).toBe('0');
    });
  });
});

// ————— Tier A site pin: pglite-bridge/snapshot-manager.ts:273 — SNAPSHOT_INVALID —————
// After implementation: the restore loop must throw PgBridgeError with
// code SNAPSHOT_INVALID when a snapshotted table no longer exists.
describe('SnapshotManager restore Tier A site pin — SNAPSHOT_INVALID (table dropped)', () => {
  // Uses an isolated PGlite so this describe does not pollute the shared fixture.
  it('rejects resetDb with PgBridgeError instanceof Error when a snapshotted table no longer exists', async () => {
    const iso = new PGlite();
    try {
      await iso.exec(
        `CREATE TABLE snap_kept_tier_a (id int);
         CREATE TABLE snap_dropped_tier_a (id int, v text);
         INSERT INTO snap_dropped_tier_a VALUES (1, 'a')`,
      );

      const snapshot = new SnapshotManager(iso);
      await snapshot.snapshotDb();

      await iso.exec('DROP TABLE snap_dropped_tier_a');

      const caught = await snapshot.resetDb().then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(caught).toBeInstanceOf(PgBridgeError);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as PgBridgeError).code).toBe('SNAPSHOT_INVALID');
      expect((caught as PgBridgeError).name).toBe('PgBridgeError');
      // Message must contain the table name and the "no longer exists" phrase
      expect((caught as PgBridgeError).message).toContain('snap_dropped_tier_a');
      expect((caught as PgBridgeError).message).toContain('no longer exists');
    } finally {
      await iso.close();
    }
  });
});

// ————— Mutation kill tests (StrykerJS survivors) —————
describe('SnapshotManager mutation survivors', () => {
  // Kills #snapshotSchemaExists self-heal survivors:
  //   L176 `if (this.#hasSnapshot) await this.#snapshotSchemaExists()` -> `if (false)`
  //   L308 method body -> `{}`
  //   L313 `if (!exists) this.#hasSnapshot = false` -> `if (false)` / -> `= true`
  // External SQL drops the snapshot schema while #hasSnapshot is still true.
  // Clean source re-probes, clears the flag, and truncates to empty; every
  // survivor leaves the flag set so #restorePlan queries the missing
  // `_pglite_snapshot.__tables` and resetDb rejects.
  it('self-heals when the snapshot schema was dropped out from under it', async () => {
    const iso = new PGlite();
    try {
      await iso.exec(
        `CREATE TABLE selfheal_t (id serial PRIMARY KEY, v text);
         INSERT INTO selfheal_t (v) VALUES ('a')`,
      );

      const snapshot = new SnapshotManager(iso);
      await snapshot.snapshotDb();

      await iso.exec(`INSERT INTO selfheal_t (v) VALUES ('b')`);
      // Simulate a caller's raw DROP SCHEMA / `prisma migrate reset`.
      await iso.exec('DROP SCHEMA "_pglite_snapshot" CASCADE');

      // Must not throw: the missing schema is detected and #hasSnapshot cleared,
      // so resetDb falls back to plain truncation.
      await snapshot.resetDb();

      const { rows } = await iso.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM selfheal_t',
      );
      expect(rows[0]?.count).toBe('0');

      const { rows: nextRow } = await iso.query<{ id: number }>(
        `INSERT INTO selfheal_t (v) VALUES ('c') RETURNING id`,
      );
      expect(nextRow[0]?.id).toBe(1);
    } finally {
      await iso.close();
    }
  });

  // Snapshot presence is probed on EVERY resetDb (`to_regnamespace`) — there
  // is no cached flag. Kills: probe body -> `{}` / `rows[0]?.exists === true`
  // -> `!== true` / `?.` -> `.` / the `hasSnapshot ? #restorePlan() : []`
  // ternary swaps. The mock flips the probe answer between calls; the restore
  // path (`__tables` plan + `__sequences` read) must follow the live answer.
  it('probes the snapshot schema on every resetDb: absent then present', async () => {
    const probeAnswers = [false, true];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      if (sql.includes('to_regnamespace')) return { rows: [{ exists: probeAnswers.shift() }] };
      return { rows: [] };
    });
    const pglite = createMockPGlite({ query });
    const snapshot = new SnapshotManager(pglite);

    await snapshot.resetDb();
    const first = query.mock.calls.map((call) => String(call[0]));
    expect(first.filter((sql) => sql.includes('to_regnamespace'))).toHaveLength(1);
    expect(first.some((sql) => sql.includes('__tables'))).toBe(false);
    expect(first.some((sql) => sql.includes('__sequences'))).toBe(false);

    query.mockClear();
    await snapshot.resetDb();
    const second = query.mock.calls.map((call) => String(call[0]));
    expect(second.filter((sql) => sql.includes('to_regnamespace'))).toHaveLength(1);
    expect(second.some((sql) => sql.includes('__tables'))).toBe(true);
    expect(second.some((sql) => sql.includes('__sequences'))).toBe(true);
    expect(probeAnswers).toHaveLength(0);
  });

  it('probes the snapshot schema on every resetDb: present then dropped externally', async () => {
    const probeAnswers = [true, false];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      if (sql.includes('to_regnamespace')) return { rows: [{ exists: probeAnswers.shift() }] };
      return { rows: [] };
    });
    const pglite = createMockPGlite({ query });
    const snapshot = new SnapshotManager(pglite);

    await snapshot.resetDb();
    const first = query.mock.calls.map((call) => String(call[0]));
    expect(first.some((sql) => sql.includes('__tables'))).toBe(true);
    expect(first.some((sql) => sql.includes('__sequences'))).toBe(true);

    // An external `DROP SCHEMA "_pglite_snapshot"` between the two calls.
    query.mockClear();
    await snapshot.resetDb();
    const second = query.mock.calls.map((call) => String(call[0]));
    expect(second.filter((sql) => sql.includes('to_regnamespace'))).toHaveLength(1);
    expect(second.some((sql) => sql.includes('__tables'))).toBe(false);
    expect(second.some((sql) => sql.includes('__sequences'))).toBe(false);
    expect(probeAnswers).toHaveLength(0);
  });

  it('treats an empty probe result as "no snapshot"', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      return { rows: [] };
    });
    const pglite = createMockPGlite({ query });
    const snapshot = new SnapshotManager(pglite);

    await expect(snapshot.resetDb()).resolves.toBeUndefined();
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes('__tables'))).toBe(false);
  });

  it('resetSnapshot does not skip the probe on the next resetDb', async () => {
    // Presence lives in the database, not in the manager: after
    // resetSnapshot the next resetDb still asks the catalog (and follows its
    // answer — the mock keeps the schema "present").
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      if (sql.includes('to_regnamespace')) return { rows: [{ exists: true }] };
      return { rows: [] };
    });
    const pglite = createMockPGlite({ query });
    const snapshot = new SnapshotManager(pglite);

    await snapshot.resetSnapshot();
    query.mockClear();
    await snapshot.resetDb();

    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.filter((sql) => sql.includes('to_regnamespace'))).toHaveLength(1);
    expect(sqls.some((sql) => sql.includes('__tables'))).toBe(true);
  });

  // Kills L299 `rows.map((row) => row.qualified).join(', ')` -> `.join('')`.
  // The empty separator fuses the two qualified names into invalid SQL
  // (`public.join_apublic.join_b`), so the TRUNCATE rejects. Clean source
  // comma-joins them and truncates both tables to empty.
  it('comma-joins every user table into a single TRUNCATE', async () => {
    const iso = new PGlite();
    try {
      await iso.exec(
        `CREATE TABLE join_a (id int); CREATE TABLE join_b (id int);
         INSERT INTO join_a VALUES (1); INSERT INTO join_b VALUES (1)`,
      );

      const snapshot = new SnapshotManager(iso);
      await snapshot.resetDb();

      const { rows } = await iso.query<{ a: string; b: string }>(
        `SELECT (SELECT count(*)::text FROM join_a) AS a,
                (SELECT count(*)::text FROM join_b) AS b`,
      );
      expect(rows[0]).toEqual({ a: '0', b: '0' });
    } finally {
      await iso.close();
    }
  });

  // Kills L281 `'SNAPSHOT_INVALID'` (missing-columns branch) -> `''`. The
  // existing column-drop test asserts only the message; this pins the code.
  it('tags the dropped-column drift error with code SNAPSHOT_INVALID', async () => {
    const iso = new PGlite();
    try {
      await iso.exec(
        `CREATE TABLE code_col_dropped (a int, b text);
         INSERT INTO code_col_dropped VALUES (1, 'x')`,
      );

      const snapshot = new SnapshotManager(iso);
      await snapshot.snapshotDb();

      await iso.exec('ALTER TABLE code_col_dropped DROP COLUMN b');

      const error = await snapshot.resetDb().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(PgBridgeError);
      expect((error as PgBridgeError).code).toBe('SNAPSHOT_INVALID');
      expect((error as PgBridgeError).message).toContain(
        'Snapshot columns b of public.code_col_dropped',
      );
    } finally {
      await iso.close();
    }
  });

  // Kills L319 `SET session_replication_role = replica` -> `''`. The restore
  // inserts run in catalog order, not FK-dependency order, so the child
  // (`achild`) is inserted before its parent (`zparent`). `replica` disables
  // FK triggers during the restore; without it the insert violates the FK.
  it('disables FK enforcement so the restore ignores insert order', async () => {
    const iso = new PGlite();
    try {
      await iso.exec(
        `CREATE TABLE zparent (id int PRIMARY KEY);
         CREATE TABLE achild (id int PRIMARY KEY, pid int REFERENCES zparent(id));
         INSERT INTO zparent VALUES (1);
         INSERT INTO achild VALUES (10, 1)`,
      );

      const snapshot = new SnapshotManager(iso);
      await snapshot.snapshotDb();

      await iso.exec('INSERT INTO zparent VALUES (2); INSERT INTO achild VALUES (20, 2)');
      await snapshot.resetDb();

      const { rows } = await iso.query<{ c: string; p: string }>(
        `SELECT (SELECT count(*)::text FROM achild) AS c,
                (SELECT count(*)::text FROM zparent) AS p`,
      );
      expect(rows[0]).toEqual({ c: '1', p: '1' });
    } finally {
      await iso.close();
    }
  });

  // The restore runs as ONE transaction with a transaction-local
  // replication-role bypass. Exact exec sequence pins: `BEGIN` -> `''`,
  // `SET LOCAL ...` -> `''`, `COMMIT` -> `''`, the setval/insert loops ->
  // `{}`, `if (hasSnapshot)` -> `if (false)`, and any reintroduction of a
  // session-level `SET session_replication_role = DEFAULT`.
  it('restores inside BEGIN / SET LOCAL / TRUNCATE / … / COMMIT and never resets the role at session level', async () => {
    const exec = vi.fn(async (_sql: string) => {});
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('to_regnamespace')) return { rows: [{ exists: true }] };
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      if (sql.includes('__tables')) {
        return {
          rows: [
            {
              snap_name_ident: '"_snap_0"',
              qualified: 'public.t',
              table_exists: true,
              cols: 'id, v',
              needs_overriding: false,
              missing_cols: null,
            },
          ],
        };
      }
      if (sql.includes('__sequences')) return { rows: [{ name: "'public.t_id_seq'", value: '7' }] };
      return { rows: [] };
    });
    const pglite = createMockPGlite({ exec, query });
    const snapshot = new SnapshotManager(pglite);

    await snapshot.resetDb();

    const execCalls = exec.mock.calls.map((call) => String(call[0]));
    expect(execCalls).toEqual([
      'BEGIN',
      'SET LOCAL session_replication_role = replica',
      'TRUNCATE TABLE public.t RESTART IDENTITY CASCADE',
      'INSERT INTO public.t (id, v) SELECT id, v FROM "_pglite_snapshot"."_snap_0"',
      "SELECT setval('public.t_id_seq', 7)",
      'COMMIT',
      expect.stringContaining('RESET ALL'),
    ]);
    expect(execCalls.some((sql) => sql.includes('session_replication_role = DEFAULT'))).toBe(false);
    expect(execCalls.some((sql) => /(^|[^L])SET session_replication_role/.test(sql))).toBe(false);
    // The scrub is the last statement, after COMMIT — never inside the
    // transaction (DISCARD TEMP cannot run in a transaction block).
    const scrub = execCalls[execCalls.length - 1] ?? '';
    expect(scrub).toContain('DISCARD TEMP');
    expect(scrub).not.toContain('COMMIT');
    // Sequences are read AFTER the truncate, inside the transaction.
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls[sqls.length - 1]).toContain('__sequences');
  });

  it('rolls back and propagates the error when the truncate fails — no COMMIT, no scrub', async () => {
    const boom = new Error('truncate boom');
    const exec = vi.fn(async (sql: string) => {
      if (sql.includes('TRUNCATE')) throw boom;
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      return { rows: [] };
    });
    const pglite = createMockPGlite({ exec, query });
    const snapshot = new SnapshotManager(pglite);

    const error = await snapshot.resetDb().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBe(boom);

    const execCalls = exec.mock.calls.map((call) => String(call[0]));
    expect(execCalls).toEqual([
      'BEGIN',
      'SET LOCAL session_replication_role = replica',
      'TRUNCATE TABLE public.t RESTART IDENTITY CASCADE',
      'ROLLBACK',
    ]);
  });

  it('rolls back and propagates a failing restore insert', async () => {
    const boom = new Error('insert boom');
    const exec = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT')) throw boom;
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('to_regnamespace')) return { rows: [{ exists: true }] };
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      if (sql.includes('__tables')) {
        return {
          rows: [
            {
              snap_name_ident: '"_snap_0"',
              qualified: 'public.t',
              table_exists: true,
              cols: null,
              needs_overriding: false,
              missing_cols: null,
            },
          ],
        };
      }
      return { rows: [] };
    });
    const pglite = createMockPGlite({ exec, query });
    const snapshot = new SnapshotManager(pglite);

    await expect(snapshot.resetDb()).rejects.toThrow('insert boom');

    const execCalls = exec.mock.calls.map((call) => String(call[0]));
    expect(execCalls.slice(-2)).toEqual([
      'INSERT INTO public.t SELECT * FROM "_pglite_snapshot"."_snap_0"',
      'ROLLBACK',
    ]);
    expect(execCalls).not.toContain('COMMIT');
    // The sequence read sits after the inserts, so a failing insert skips it.
    const sqls = query.mock.calls.map((call) => String(call[0]));
    expect(sqls.some((sql) => sql.includes('__sequences'))).toBe(false);
  });

  it('surfaces the original error even when the ROLLBACK itself fails', async () => {
    const boom = new Error('truncate boom');
    const rollbackBoom = new Error('rollback boom');
    const exec = vi.fn(async (sql: string) => {
      if (sql.includes('TRUNCATE')) throw boom;
      if (sql === 'ROLLBACK') throw rollbackBoom;
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
      return { rows: [] };
    });
    const pglite = createMockPGlite({ exec, query });
    const snapshot = new SnapshotManager(pglite);

    const error = await snapshot.resetDb().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBe(boom);
    expect(exec.mock.calls.map((call) => String(call[0]))).toContain('ROLLBACK');
  });

  // Kills `options.scrubSession !== false` -> `=== false` / `true` / `false`
  // and `if (scrubSession)` -> `if (true)` / `if (false)`.
  describe('scrubSession', () => {
    const scrubbedDb = () => {
      const exec = vi.fn(async (_sql: string) => {});
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('pg_tables')) return { rows: [{ qualified: 'public.t' }] };
        return { rows: [] };
      });
      return { exec, snapshot: new SnapshotManager(createMockPGlite({ exec, query })) };
    };
    const execSql = (exec: ReturnType<typeof scrubbedDb>['exec']): string[] =>
      exec.mock.calls.map((call) => String(call[0]));

    it('false runs the transaction but none of the scrub statements', async () => {
      const { exec, snapshot } = scrubbedDb();
      await snapshot.resetDb({ scrubSession: false });

      const execCalls = execSql(exec);
      expect(execCalls).toEqual([
        'BEGIN',
        'SET LOCAL session_replication_role = replica',
        'TRUNCATE TABLE public.t RESTART IDENTITY CASCADE',
        'COMMIT',
      ]);
      const joined = execCalls.join('\n');
      expect(joined).not.toContain('RESET ALL');
      expect(joined).not.toContain('DISCARD TEMP');
      expect(joined).not.toContain('CLOSE ALL');
      expect(joined).not.toContain('UNLISTEN');
      expect(joined).not.toContain('pg_advisory_unlock_all');
    });

    it.each([
      ['omitted', undefined],
      ['{}', {}],
      ['{ scrubSession: true }', { scrubSession: true }],
    ])('%s runs the scrub after COMMIT', async (_label, options) => {
      const { exec, snapshot } = scrubbedDb();
      await snapshot.resetDb(options);

      const execCalls = execSql(exec);
      expect(execCalls).toHaveLength(5);
      expect(execCalls[3]).toBe('COMMIT');
      expect(execCalls[4]).toContain('RESET ALL');
      expect(execCalls[4]).toContain('DISCARD TEMP');
    });
  });
});
