import { afterEach, describe, expect, it } from 'vitest';
import { setupPGlite } from '../__tests__/pglite.ts';
import { SnapshotManager } from './snapshot-manager.ts';

const db = await setupPGlite({ reset: false });
const snapshot = new SnapshotManager(db);

afterEach(async () => {
  await snapshot.resetSnapshot();
  await db.exec('DROP SCHEMA IF EXISTS reset_cases CASCADE');
});

describe('snapshot restore edge cases', () => {
  it('restores multilevel partitions without duplicating rows', async () => {
    await db.exec(`
      CREATE SCHEMA reset_cases;
      CREATE TABLE reset_cases.events (id int, bucket int, PRIMARY KEY (id, bucket))
        PARTITION BY RANGE (bucket);
      CREATE TABLE reset_cases.low PARTITION OF reset_cases.events
        FOR VALUES FROM (0) TO (10) PARTITION BY RANGE (bucket);
      CREATE TABLE reset_cases.leaf PARTITION OF reset_cases.low FOR VALUES FROM (0) TO (10);
      CREATE TABLE reset_cases.high PARTITION OF reset_cases.events FOR VALUES FROM (10) TO (20);
      INSERT INTO reset_cases.events VALUES (1, 1), (2, 11);
    `);
    await snapshot.snapshotDb();
    await db.exec('INSERT INTO reset_cases.events VALUES (3, 3), (4, 14)');
    await snapshot.resetDb();
    expect((await db.query('SELECT * FROM reset_cases.events ORDER BY id')).rows).toEqual([
      { id: 1, bucket: 1 },
      { id: 2, bucket: 11 },
    ]);
    await snapshot.resetDb();
    expect((await db.query('SELECT count(*)::int AS n FROM reset_cases.events')).rows).toEqual([
      { n: 2 },
    ]);
  });

  it('preserves the physical table of inherited rows and excludes dropped columns', async () => {
    await db.exec(`
      CREATE SCHEMA reset_cases;
      CREATE TABLE reset_cases.parent (id int, obsolete text, value text);
      ALTER TABLE reset_cases.parent DROP COLUMN obsolete;
      CREATE TABLE reset_cases.child (extra int) INHERITS (reset_cases.parent);
      INSERT INTO reset_cases.parent VALUES (1, 'parent');
      INSERT INTO reset_cases.child VALUES (2, 'child', 42);
    `);
    await snapshot.snapshotDb();
    await db.exec("UPDATE reset_cases.parent SET value = 'mutated'");
    await snapshot.resetDb();
    expect((await db.query('SELECT * FROM ONLY reset_cases.parent')).rows).toEqual([
      { id: 1, value: 'parent' },
    ]);
    expect((await db.query('SELECT * FROM reset_cases.child')).rows).toEqual([
      { id: 2, value: 'child', extra: 42 },
    ]);
  });

  it('restores an unconsumed custom identity value exactly', async () => {
    await db.exec(`
      CREATE SCHEMA reset_cases;
      CREATE TABLE reset_cases.ids (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
      SELECT setval('reset_cases.ids_id_seq', 9007199254740993, false);
    `);
    await snapshot.snapshotDb();
    await db.exec('INSERT INTO reset_cases.ids DEFAULT VALUES');
    await snapshot.resetDb();
    expect(
      (await db.query('INSERT INTO reset_cases.ids DEFAULT VALUES RETURNING id::text')).rows,
    ).toEqual([{ id: '9007199254740993' }]);
  });

  it('restores standalone and never-used sequences in a database without user tables', async () => {
    await db.exec(`
      CREATE SCHEMA reset_cases;
      CREATE SEQUENCE reset_cases.unused START 17 INCREMENT 3;
      CREATE SEQUENCE reset_cases.used START 30 INCREMENT -2 MINVALUE 1 MAXVALUE 30;
      SELECT nextval('reset_cases.used');
    `);
    await snapshot.snapshotDb();
    await db.exec("SELECT nextval('reset_cases.unused'), nextval('reset_cases.used')");
    await snapshot.resetDb();
    expect(
      (
        await db.query(`SELECT nextval('reset_cases.unused')::text AS unused,
      nextval('reset_cases.used')::text AS used`)
      ).rows,
    ).toEqual([{ unused: '17', used: '28' }]);
  });

  it('restores persisted snapshots whose sequence metadata predates is_called', async () => {
    await db.exec(`
      CREATE SCHEMA reset_cases;
      CREATE TABLE reset_cases.legacy (id serial PRIMARY KEY);
      INSERT INTO reset_cases.legacy DEFAULT VALUES;
    `);
    await snapshot.snapshotDb();
    await db.exec(`
      ALTER TABLE _pglite_snapshot.__sequences DROP COLUMN is_called;
      INSERT INTO reset_cases.legacy DEFAULT VALUES;
    `);
    await snapshot.resetDb();
    expect(
      (await db.query('INSERT INTO reset_cases.legacy DEFAULT VALUES RETURNING id')).rows,
    ).toEqual([{ id: 2 }]);
  });

  it('rolls back the whole restore batch after an insert failure and remains reusable', async () => {
    await db.exec(`
      CREATE SCHEMA reset_cases;
      CREATE TABLE reset_cases.a (value int);
      CREATE TABLE reset_cases.z (value int);
      INSERT INTO reset_cases.a VALUES (1);
      INSERT INTO reset_cases.z VALUES (1);
    `);
    await snapshot.snapshotDb();
    await db.exec(`
      UPDATE reset_cases.a SET value = 9;
      UPDATE reset_cases.z SET value = 9;
      ALTER TABLE reset_cases.z ADD CONSTRAINT positive CHECK (value > 5);
      SET application_name = 'keep-on-error';
    `);
    try {
      await expect(snapshot.resetDb()).rejects.toThrow('positive');
      expect(
        (
          await db.query(`SELECT value FROM reset_cases.a
        UNION ALL SELECT value FROM reset_cases.z`)
        ).rows,
      ).toEqual([{ value: 9 }, { value: 9 }]);
      expect(
        (
          await db.query(`SELECT current_setting('session_replication_role') AS role,
        current_setting('application_name') AS app`)
        ).rows,
      ).toEqual([{ role: 'origin', app: 'keep-on-error' }]);
      await db.exec('ALTER TABLE reset_cases.z DROP CONSTRAINT positive');
      await snapshot.resetDb();
      expect(
        (
          await db.query(`SELECT value FROM reset_cases.a
        UNION ALL SELECT value FROM reset_cases.z`)
        ).rows,
      ).toEqual([{ value: 1 }, { value: 1 }]);
    } finally {
      await db.exec('RESET ALL');
    }
  });

  it('quotes identifiers and sequence literals across batched statements', async () => {
    await db.exec(`
      CREATE SCHEMA reset_cases;
      CREATE TABLE reset_cases."odd';""table" (id serial, "col';""name" text);
      INSERT INTO reset_cases."odd';""table" ("col';""name") VALUES ('seed');
    `);
    await snapshot.snapshotDb();
    await db.exec(`INSERT INTO reset_cases."odd';""table" ("col';""name") VALUES ('extra')`);
    await snapshot.resetDb();
    expect((await db.query(`SELECT * FROM reset_cases."odd';""table"`)).rows).toEqual([
      { id: 1, 'col\';"name': 'seed' },
    ]);
    expect(
      (await db.query(`INSERT INTO reset_cases."odd';""table" DEFAULT VALUES RETURNING id`)).rows,
    ).toEqual([{ id: 2 }]);
  });
});
