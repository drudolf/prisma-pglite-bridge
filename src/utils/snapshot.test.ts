import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

import setupPGlite from '../__tests__/pglite.ts';
import { createSnapshotManager } from './snapshot.ts';

const pglite = await setupPGlite();

describe('snapshot manager', () => {
  it('rolls back and drops the snapshot schema if snapshot creation fails', async () => {
    const error = new Error('boom');
    const pglite = {
      exec: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(error),
    } as unknown as PGlite;

    const snapshot = createSnapshotManager(pglite);

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

    const snapshot = createSnapshotManager(pglite);
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

  it('drops the stored snapshot so resetDb truncates to empty again', async () => {
    await pglite.exec(
      "CREATE TABLE users (id serial PRIMARY KEY, name text NOT NULL); INSERT INTO users (name) VALUES ('alice')",
    );

    const snapshot = createSnapshotManager(pglite);
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

  it('skips truncation work when no user tables exist', async () => {
    const pglite = {
      exec: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as PGlite;

    const snapshot = createSnapshotManager(pglite);

    await snapshot.resetDb();

    expect(vi.mocked(pglite.exec).mock.calls).toEqual([['DISCARD ALL']]);
    expect(vi.mocked(pglite.query).mock.calls).toHaveLength(1);
  });
});
