import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupPGlite } from '../__tests__/pglite.ts';
import { SnapshotManager } from './snapshot-manager.ts';

const db = await setupPGlite({ reset: false });

// Advance through five 16 MiB WAL segments without constructing a large seed.
// A message ensures each switch sees new WAL rather than reusing an empty segment.
const growWal = async (segments = 5) => {
  await db.exec(
    Array.from(
      { length: segments },
      () => `SELECT pg_logical_emit_message(false, 'checkpoint-test', 'advance');
             SELECT pg_switch_wal();`,
    ).join('\n'),
  );
};
const checkpointLsn = async () =>
  (await db.query<{ redo_lsn: string }>('SELECT redo_lsn::text FROM pg_control_checkpoint()'))
    .rows[0]?.redo_lsn;
const seed = async () => {
  await db.exec(`CREATE SCHEMA checkpoint_cases;
    CREATE TABLE checkpoint_cases.data (value int);
    INSERT INTO checkpoint_cases.data VALUES (1)`);
};

afterEach(async () => {
  vi.restoreAllMocks();
  await db.exec('RESET ROLE');
  await new SnapshotManager(db).resetSnapshot();
  await db.exec('DROP SCHEMA IF EXISTS checkpoint_cases CASCADE');
});

describe('snapshot WAL checkpoints', () => {
  it('advances the real checkpoint after WAL growth and skips small subsequent operations', async () => {
    await seed();
    const manager = new SnapshotManager(db);
    await manager.snapshotDb();
    await growWal();
    const before = await checkpointLsn();
    const exec = vi.spyOn(db, 'exec');

    await manager.resetDb();
    expect(await checkpointLsn()).not.toBe(before);
    await manager.snapshotDb();
    await manager.resetDb();
    expect(exec.mock.calls.filter(([sql]) => sql === 'CHECKPOINT')).toHaveLength(1);
    expect((await db.query('SELECT * FROM checkpoint_cases.data')).rows).toEqual([{ value: 1 }]);
  });

  it('waits for 64 MiB since the database checkpoint, independent of its absolute LSN', async () => {
    await seed();
    await growWal();
    await db.exec('CHECKPOINT');
    const exec = vi.spyOn(db, 'exec');
    const manager = new SnapshotManager(db);
    await growWal(3);
    await manager.snapshotDb();
    expect(exec.mock.calls.some(([sql]) => sql === 'CHECKPOINT')).toBe(false);
    await growWal(2);
    await manager.resetDb();
    expect(exec.mock.calls.filter(([sql]) => sql === 'CHECKPOINT')).toHaveLength(1);
  });

  it('observes repeated peer and manual checkpoints without recreating managers', async () => {
    await seed();
    const a = new SnapshotManager(db);
    const b = new SnapshotManager(db);
    await a.snapshotDb();
    const exec = vi.spyOn(db, 'exec');
    for (let cycle = 0; cycle < 2; cycle++) {
      await growWal();
      exec.mockClear();
      await a.resetDb();
      await b.snapshotDb();
      await b.resetDb();
      expect(exec.mock.calls.filter(([sql]) => sql === 'CHECKPOINT')).toHaveLength(1);

      await growWal();
      await db.exec('CHECKPOINT');
      exec.mockClear();
      await a.snapshotDb();
      await a.resetDb();
      await b.resetDb();
      await new SnapshotManager(db).snapshotDb();
      expect(exec.mock.calls.some(([sql]) => sql === 'CHECKPOINT')).toBe(false);
      expect((await db.query('SELECT * FROM checkpoint_cases.data')).rows).toEqual([{ value: 1 }]);
    }
  });

  it.each(['snapshotDb', 'resetDb'] as const)(
    'preserves live data and the prior snapshot when checkpointing before %s fails, then retries',
    async (operation) => {
      await seed();
      const manager = new SnapshotManager(db);
      await manager.snapshotDb();
      await db.exec('INSERT INTO checkpoint_cases.data VALUES (2)');
      await growWal();
      const originalExec = db.exec.bind(db);
      const failure = new Error('checkpoint write failed');
      let attempts = 0;
      vi.spyOn(db, 'exec').mockImplementation(async (sql, options) => {
        if (sql === 'CHECKPOINT' && ++attempts === 1) throw failure;
        return originalExec(sql, options);
      });

      await expect(manager[operation]()).rejects.toBe(failure);
      expect((await db.query('SELECT * FROM checkpoint_cases.data ORDER BY value')).rows).toEqual([
        { value: 1 },
        { value: 2 },
      ]);
      expect((await db.query('SELECT * FROM _pglite_snapshot._snap_0')).rows).toEqual([
        { value: 1 },
      ]);
      await manager.resetDb();
      expect(attempts).toBe(2);
      expect((await db.query('SELECT * FROM checkpoint_cases.data')).rows).toEqual([{ value: 1 }]);
    },
  );

  it('still captures snapshots for a role without checkpoint privileges', async () => {
    await seed();
    await growWal();
    await db.exec(`CREATE ROLE checkpoint_limited;
      GRANT CREATE ON DATABASE postgres TO checkpoint_limited;
      GRANT USAGE ON SCHEMA checkpoint_cases TO checkpoint_limited;
      GRANT SELECT ON checkpoint_cases.data TO checkpoint_limited;
      SET ROLE checkpoint_limited`);
    try {
      const exec = vi.spyOn(db, 'exec');
      await new SnapshotManager(db).snapshotDb();
      expect(exec.mock.calls.some(([sql]) => sql === 'CHECKPOINT')).toBe(false);
      expect((await db.query('SELECT * FROM _pglite_snapshot._snap_0')).rows).toEqual([
        { value: 1 },
      ]);
    } finally {
      await db.exec('RESET ROLE');
      await db.exec('DROP OWNED BY checkpoint_limited; DROP ROLE checkpoint_limited');
    }
  });
});
