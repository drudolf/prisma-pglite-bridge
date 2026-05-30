import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import { quoteIdent } from '../utils/quote-ident.ts';

const SNAPSHOT_SCHEMA = '_pglite_snapshot';

const SYSTEM_SCHEMA_EXCLUSION = `schemaname NOT IN ('pg_catalog', 'information_schema')
       AND schemaname != '${SNAPSHOT_SCHEMA}'`;

const USER_TABLES_WHERE = `${SYSTEM_SCHEMA_EXCLUSION}
       AND tablename NOT LIKE '_prisma%'`;

const escapeLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const SNAPSHOT_SCHEMA_IDENT = quoteIdent(SNAPSHOT_SCHEMA);
const SNAPSHOT_SCHEMA_LITERAL = escapeLiteral(SNAPSHOT_SCHEMA);

/**
 * Snapshot helpers backing `PGliteBridge`'s `snapshotDb` / `resetDb` /
 * `resetSnapshot` functions. Stores a copy of user tables and sequence
 * values in a dedicated `_pglite_snapshot` schema so tests can reset to a
 * known seed state without re-running migrations.
 *
 * @internal
 */
export class SnapshotManager {
  readonly #pglite: PGlite | PGliteInterface;
  #hasSnapshot = false;

  constructor(pglite: PGlite | PGliteInterface) {
    this.#pglite = pglite;
  }

  /**
   * Capture the current state of all user tables plus sequence values into
   * the `_pglite_snapshot` schema. Replaces any previous snapshot.
   */
  async snapshotDb(): Promise<void> {
    const pglite = this.#pglite;
    await pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_IDENT} CASCADE`);

    try {
      await pglite.exec('BEGIN');
      await pglite.exec(`CREATE SCHEMA ${SNAPSHOT_SCHEMA_IDENT}`);

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
        `CREATE TABLE ${SNAPSHOT_SCHEMA_IDENT}.__tables (snap_name text, source_schema text, source_table text)`,
      );

      for (const [i, { schemaname, tablename, qualified }] of tables.entries()) {
        const snapName = `_snap_${i}`;
        await pglite.exec(
          `CREATE TABLE ${SNAPSHOT_SCHEMA_IDENT}.${quoteIdent(snapName)} AS SELECT * FROM ${qualified}`,
        );
        await pglite.exec(
          `INSERT INTO ${SNAPSHOT_SCHEMA_IDENT}.__tables VALUES (${escapeLiteral(snapName)}, ${escapeLiteral(schemaname)}, ${escapeLiteral(tablename)})`,
        );
      }

      const { rows: seqs } = await pglite.query<{ name: string; value: string }>(
        `SELECT quote_literal(quote_ident(schemaname) || '.' || quote_ident(sequencename)) AS name, last_value::text AS value
         FROM pg_sequences
         WHERE ${SYSTEM_SCHEMA_EXCLUSION}
         AND last_value IS NOT NULL`,
      );

      await pglite.exec(
        `CREATE TABLE ${SNAPSHOT_SCHEMA_IDENT}.__sequences (name text, value bigint)`,
      );
      for (const { name, value } of seqs) {
        await pglite.exec(
          `INSERT INTO ${SNAPSHOT_SCHEMA_IDENT}.__sequences VALUES (${name}, ${value})`,
        );
      }

      await pglite.exec('COMMIT');
    } catch (err) {
      await pglite.exec('ROLLBACK');
      await pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_IDENT} CASCADE`);
      throw err;
    }

    this.#hasSnapshot = true;
  }

  /** Drop the saved snapshot, reverting `resetDb` to plain truncation. */
  async resetSnapshot(): Promise<void> {
    this.#hasSnapshot = false;
    await this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_IDENT} CASCADE`);
  }

  /**
   * Truncate all user tables. If a snapshot exists, restore its contents and
   * sequence values afterwards; otherwise just truncate and `DISCARD ALL`.
   */
  async resetDb(): Promise<void> {
    const pglite = this.#pglite;
    if (this.#hasSnapshot) await this.#snapshotSchemaExists();

    const tables = await this.#getTables();

    if (tables) {
      await this.#withReplicationRoleReplica(async () => {
        await pglite.exec(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);

        if (!this.#hasSnapshot) return;

        const { rows: snapshotTables } = await pglite.query<{
          snap_name_ident: string;
          qualified: string;
        }>(
          `SELECT quote_ident(snap_name) AS snap_name_ident,
                  quote_ident(source_schema) || '.' || quote_ident(source_table) AS qualified
           FROM ${SNAPSHOT_SCHEMA_IDENT}.__tables`,
        );

        for (const { snap_name_ident, qualified } of snapshotTables) {
          await pglite.exec(
            `INSERT INTO ${qualified} SELECT * FROM ${SNAPSHOT_SCHEMA_IDENT}.${snap_name_ident}`,
          );
        }

        const { rows: seqs } = await pglite.query<{ name: string; value: string }>(
          `SELECT quote_literal(name) AS name, value::text AS value FROM ${SNAPSHOT_SCHEMA_IDENT}.__sequences`,
        );

        for (const { name, value } of seqs) {
          await pglite.exec(`SELECT setval(${name}, ${value})`);
        }
      });
    }

    await pglite.exec('DISCARD ALL');
  }

  async #getTables(): Promise<string> {
    const { rows } = await this.#pglite.query<{ qualified: string }>(
      `SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
       FROM pg_tables
       WHERE ${USER_TABLES_WHERE}`,
    );
    return rows.map((row) => row.qualified).join(', ');
  }

  /**
   * Self-heal: someone (e.g. `resetSchema`) may drop `_pglite_snapshot`
   * out from under us. Returns whether the schema actually exists right now,
   * and clears `#hasSnapshot` if it doesn't.
   */
  async #snapshotSchemaExists(): Promise<boolean> {
    const { rows } = await this.#pglite.query<{ exists: boolean }>(
      `SELECT to_regnamespace(${SNAPSHOT_SCHEMA_LITERAL}) IS NOT NULL AS exists`,
    );
    const exists = rows[0]?.exists;
    if (!exists) this.#hasSnapshot = false;
    return !!exists;
  }

  async #withReplicationRoleReplica(fn: () => Promise<void>): Promise<void> {
    try {
      await this.#pglite.exec('SET session_replication_role = replica');
      await fn();
    } finally {
      await this.#pglite.exec('SET session_replication_role = DEFAULT');
    }
  }
}
