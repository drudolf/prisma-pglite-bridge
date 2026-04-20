import type { PGlite } from '@electric-sql/pglite';
import { SENTINEL_SCHEMA } from './sentinel.ts';

export const SNAPSHOT_SCHEMA = '_pglite_snapshot';

const USER_TABLES_WHERE = `schemaname NOT IN ('pg_catalog', 'information_schema')
       AND schemaname != '${SNAPSHOT_SCHEMA}'
       AND schemaname != '${SENTINEL_SCHEMA}'
       AND tablename NOT LIKE '_prisma%'`;

const escapeLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

export interface SnapshotManager {
  resetDb: () => Promise<void>;
  resetSnapshot: () => Promise<void>;
  snapshotDb: () => Promise<void>;
}

export const createSnapshotManager = (pglite: PGlite): SnapshotManager => {
  let hasSnapshot = false;

  const getTables = async () => {
    const { rows } = await pglite.query<{ qualified: string }>(
      `SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
       FROM pg_tables
       WHERE ${USER_TABLES_WHERE}`,
    );
    return rows.length > 0
      ? rows.map((row: { qualified: string }) => row.qualified).join(', ')
      : '';
  };

  const snapshotDb = async () => {
    await pglite.exec(`DROP SCHEMA IF EXISTS "${SNAPSHOT_SCHEMA}" CASCADE`);

    try {
      await pglite.exec('BEGIN');
      await pglite.exec(`CREATE SCHEMA "${SNAPSHOT_SCHEMA}"`);

      const { rows: tables } = await pglite.query<{
        schemaname: string;
        tablename: string;
        qualified: string;
      }>(
        `SELECT schemaname, tablename,
                quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
         FROM pg_tables
         WHERE ${USER_TABLES_WHERE}`,
      );

      await pglite.exec(
        `CREATE TABLE "${SNAPSHOT_SCHEMA}".__tables (snap_name text, source_schema text, source_table text)`,
      );

      for (const [i, { schemaname, tablename, qualified }] of tables.entries()) {
        const snapName = `_snap_${i}`;
        await pglite.exec(
          `CREATE TABLE "${SNAPSHOT_SCHEMA}"."${snapName}" AS SELECT * FROM ${qualified}`,
        );
        await pglite.exec(
          `INSERT INTO "${SNAPSHOT_SCHEMA}".__tables VALUES (${escapeLiteral(snapName)}, ${escapeLiteral(schemaname)}, ${escapeLiteral(tablename)})`,
        );
      }

      const { rows: seqs } = await pglite.query<{ name: string; value: string }>(
        `SELECT quote_literal(schemaname || '.' || sequencename) AS name, last_value::text AS value
         FROM pg_sequences
         WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
         AND schemaname != '${SNAPSHOT_SCHEMA}'
         AND last_value IS NOT NULL`,
      );

      await pglite.exec(`CREATE TABLE "${SNAPSHOT_SCHEMA}".__sequences (name text, value bigint)`);
      for (const { name, value } of seqs) {
        await pglite.exec(
          `INSERT INTO "${SNAPSHOT_SCHEMA}".__sequences VALUES (${name}, ${value})`,
        );
      }

      await pglite.exec('COMMIT');
    } catch (err) {
      await pglite.exec('ROLLBACK');
      await pglite.exec(`DROP SCHEMA IF EXISTS "${SNAPSHOT_SCHEMA}" CASCADE`);
      throw err;
    }

    hasSnapshot = true;
  };

  const resetSnapshot = async () => {
    hasSnapshot = false;
    await pglite.exec(`DROP SCHEMA IF EXISTS "${SNAPSHOT_SCHEMA}" CASCADE`);
  };

  const resetDb = async () => {
    const tables = await getTables();

    if (hasSnapshot && tables) {
      try {
        await pglite.exec('SET session_replication_role = replica');
        await pglite.exec(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);

        const { rows: snapshotTables } = await pglite.query<{
          snap_name: string;
          qualified: string;
        }>(
          `SELECT snap_name, quote_ident(source_schema) || '.' || quote_ident(source_table) AS qualified
           FROM "${SNAPSHOT_SCHEMA}".__tables`,
        );

        for (const { snap_name, qualified } of snapshotTables) {
          await pglite.exec(
            `INSERT INTO ${qualified} SELECT * FROM "${SNAPSHOT_SCHEMA}"."${snap_name}"`,
          );
        }

        const { rows: seqs } = await pglite.query<{ name: string; value: string }>(
          `SELECT quote_literal(name) AS name, value::text AS value FROM "${SNAPSHOT_SCHEMA}".__sequences`,
        );

        for (const { name, value } of seqs) {
          await pglite.exec(`SELECT setval(${name}, ${value})`);
        }
      } finally {
        await pglite.exec('SET session_replication_role = DEFAULT');
      }
    } else if (tables) {
      try {
        await pglite.exec('SET session_replication_role = replica');
        await pglite.exec(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
      } finally {
        await pglite.exec('SET session_replication_role = DEFAULT');
      }
    }

    await pglite.exec('DISCARD ALL');
  };

  return { resetDb, resetSnapshot, snapshotDb };
};
