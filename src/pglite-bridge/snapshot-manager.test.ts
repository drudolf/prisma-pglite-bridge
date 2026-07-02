import { describe, expect, it, vi } from 'vitest';

import { createMockPGlite } from '../__tests__/mocks.ts';
import { setupPGlite } from '../__tests__/pglite.ts';
import { SnapshotManager } from './snapshot-manager.ts';

const pglite = await setupPGlite();

describe('snapshot manager', () => {
  it('rolls back and drops the snapshot schema if snapshot creation fails', async () => {
    const error = new Error('boom');
    const pglite = createMockPGlite({ query: vi.fn().mockRejectedValue(error) });

    const snapshot = new SnapshotManager(pglite);

    await expect(snapshot.snapshotDb()).rejects.toThrow(error);
    expect(vi.mocked(pglite.exec).mock.calls).toEqual([
      [`DROP SCHEMA IF EXISTS "_pglite_snapshot" CASCADE`],
      ['BEGIN'],
      [`CREATE SCHEMA "_pglite_snapshot"`],
      ['ROLLBACK'],
      [`DROP SCHEMA IF EXISTS "_pglite_snapshot" CASCADE`],
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

  it('skips truncation work and resets session state without deallocating statements', async () => {
    const pglite = createMockPGlite();

    const snapshot = new SnapshotManager(pglite);

    await snapshot.resetDb();

    const executed = vi
      .mocked(pglite.exec)
      .mock.calls.map((call) => String(call[0]))
      .join('\n');
    expect(executed).not.toContain('TRUNCATE');
    // Granular equivalent of DISCARD ALL minus DEALLOCATE ALL: session vars
    // reset, temp tables and plans discarded — prepared statements survive.
    expect(executed).toContain('RESET ALL');
    expect(executed).toContain('DISCARD TEMP');
    expect(executed).toContain('DISCARD PLANS');
    expect(executed).not.toContain('DEALLOCATE');
    expect(executed).not.toContain('DISCARD ALL');
    expect(vi.mocked(pglite.query).mock.calls).toHaveLength(1);
  });

  it('keeps named prepared statements usable across resetDb', async () => {
    await pglite.exec('PREPARE snapshot_manager_probe AS SELECT 42 AS answer');

    const snapshot = new SnapshotManager(pglite);
    await snapshot.resetDb();

    const { rows } = await pglite.query<{ answer: number }>('EXECUTE snapshot_manager_probe');
    expect(rows).toEqual([{ answer: 42 }]);

    await pglite.exec('DEALLOCATE snapshot_manager_probe');
  });
});
