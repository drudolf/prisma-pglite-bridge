import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import { quoteIdent } from '../utils/quote-ident.ts';

const SNAPSHOT_SCHEMA = '_pglite_snapshot';
/** Rebuild staging schema — swapped into place atomically on success. */
const SNAPSHOT_SCHEMA_NEW = '_pglite_snapshot_new';

const SYSTEM_SCHEMA_EXCLUSION = `schemaname NOT IN ('pg_catalog', 'information_schema')
       AND schemaname != '${SNAPSHOT_SCHEMA}'
       AND schemaname != '${SNAPSHOT_SCHEMA_NEW}'`;

const USER_TABLES_WHERE = `${SYSTEM_SCHEMA_EXCLUSION}
       AND tablename NOT LIKE '_prisma%'`;

const SNAPSHOT_SCHEMA_IDENT = quoteIdent(SNAPSHOT_SCHEMA);
const SNAPSHOT_SCHEMA_NEW_IDENT = quoteIdent(SNAPSHOT_SCHEMA_NEW);
// SNAPSHOT_SCHEMA is a fixed internal identifier (no quotes) — safe to embed
// as a SQL string literal. Dynamic catalog values (schema/table names) are
// never escaped by hand: they go through bind parameters or the DB's own
// quote_ident()/quote_literal() at their use site.
const SNAPSHOT_SCHEMA_LITERAL = `'${SNAPSHOT_SCHEMA}'`;

/**
 * Snapshot helpers backing `PGliteBridge`'s `snapshotDb` / `resetDb` /
 * `resetSnapshot` functions. Stores a copy of user tables and sequence
 * values in a dedicated `_pglite_snapshot` schema so tests can reset to a
 * known seed state without re-running migrations.
 *
 * Operations are serialized per manager instance, not per session: a
 * second bridge's snapshot calls against the same shared PGlite session
 * are not serialized against this one's (covered only by the
 * shared-instance advisory warning).
 *
 * @internal
 */
export class SnapshotManager {
  readonly #pglite: PGlite | PGliteInterface;
  #hasSnapshot = false;
  /** Tail of the serialized operation chain — see {@link #serialize}. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(pglite: PGlite | PGliteInterface) {
    this.#pglite = pglite;
  }

  /**
   * Serialize the public operations: each issues a multi-statement SQL
   * sequence against the shared single session, and two of them interleaving
   * at the JS promise level (e.g. an un-awaited `resetDb` racing a
   * `snapshotDb`) would corrupt both. A failed operation does not poison the
   * chain for the next one.
   */
  #serialize<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(op, op);
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Capture the current state of all user tables plus sequence values into
   * the `_pglite_snapshot` schema. Replaces any previous snapshot — but only
   * on success: the rebuild happens under a staging schema inside one
   * transaction and is swapped into place at commit, so a failed re-snapshot
   * leaves the previous snapshot fully restorable.
   */
  snapshotDb(): Promise<void> {
    return this.#serialize(() => this.#snapshotDb());
  }

  async #snapshotDb(): Promise<void> {
    // Clear staging leftovers from a hard crash mid-build (persisted dataDir).
    await this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_NEW_IDENT} CASCADE`);

    try {
      await this.#pglite.exec('BEGIN');
      await this.#pglite.exec(`CREATE SCHEMA ${SNAPSHOT_SCHEMA_NEW_IDENT}`);

      const { rows: tables } = await this.#pglite.query<{
        schemaname: string;
        tablename: string;
        qualified: string;
      }>(
        `SELECT schemaname, tablename,
                quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
         FROM pg_tables
         WHERE ${USER_TABLES_WHERE}
         ORDER BY schemaname, tablename`,
      );

      await this.#pglite.exec(
        `CREATE TABLE ${SNAPSHOT_SCHEMA_NEW_IDENT}.__tables (snap_name text, source_schema text, source_table text)`,
      );

      for (const [i, { schemaname, tablename, qualified }] of tables.entries()) {
        const snapName = `_snap_${i}`;
        await this.#pglite.exec(
          `CREATE TABLE ${SNAPSHOT_SCHEMA_NEW_IDENT}.${quoteIdent(snapName)} AS SELECT * FROM ${qualified}`,
        );
        await this.#pglite.query(
          `INSERT INTO ${SNAPSHOT_SCHEMA_NEW_IDENT}.__tables VALUES ($1, $2, $3)`,
          [snapName, schemaname, tablename],
        );
      }

      const { rows: seqs } = await this.#pglite.query<{ name: string; value: string }>(
        `SELECT quote_literal(quote_ident(schemaname) || '.' || quote_ident(sequencename)) AS name, last_value::text AS value
         FROM pg_sequences
         WHERE ${SYSTEM_SCHEMA_EXCLUSION}
         AND last_value IS NOT NULL`,
      );

      await this.#pglite.exec(
        `CREATE TABLE ${SNAPSHOT_SCHEMA_NEW_IDENT}.__sequences (name text, value bigint)`,
      );
      for (const { name, value } of seqs) {
        await this.#pglite.exec(
          `INSERT INTO ${SNAPSHOT_SCHEMA_NEW_IDENT}.__sequences VALUES (${name}, ${value})`,
        );
      }

      // The swap. DDL is transactional, so the old snapshot survives any
      // failure before COMMIT. Peak footprint is briefly live tables + old
      // snapshot + new snapshot (+ MVCC) — the price of atomicity, fine for
      // an in-memory test database.
      await this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_IDENT} CASCADE`);
      await this.#pglite.exec(
        `ALTER SCHEMA ${SNAPSHOT_SCHEMA_NEW_IDENT} RENAME TO ${SNAPSHOT_SCHEMA_IDENT}`,
      );
      await this.#pglite.exec('COMMIT');
    } catch (err) {
      // Best-effort cleanup — the build error is what must propagate. The
      // rolled-back transaction leaves the previous snapshot (and
      // #hasSnapshot) untouched.
      await this.#pglite
        .exec('ROLLBACK')
        .then(() => this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_NEW_IDENT} CASCADE`))
        .catch(() => {});
      throw err;
    }

    this.#hasSnapshot = true;
  }

  /** Drop the saved snapshot (and any interrupted-rebuild staging schema),
   *  reverting `resetDb` to plain truncation. */
  resetSnapshot(): Promise<void> {
    return this.#serialize(() => this.#resetSnapshot());
  }

  async #resetSnapshot(): Promise<void> {
    this.#hasSnapshot = false;
    await this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_IDENT} CASCADE`);
    await this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_NEW_IDENT} CASCADE`);
  }

  /**
   * Truncate all user tables. If a snapshot exists, restore its contents and
   * sequence values afterwards. Either way, finish with the session reset
   * below — everything `DISCARD ALL` covers except `DEALLOCATE ALL`, so
   * named prepared statements survive.
   *
   * Requires the live schema to still structurally match the snapshot:
   * a source table or column dropped since `snapshotDb()` fails fast
   * (before anything is truncated), and other column drift surfaces as an
   * insert error against the snapshot table.
   */
  resetDb(): Promise<void> {
    return this.#serialize(() => this.#resetDb());
  }

  async #resetDb(): Promise<void> {
    if (this.#hasSnapshot) await this.#snapshotSchemaExists();

    const tables = await this.#getTables();

    // Plan the restore before truncating — and even when no live user
    // table is left to truncate — so schema drift since snapshotDb()
    // fails loudly with the data still intact.
    const restore = this.#hasSnapshot ? await this.#restorePlan() : [];

    if (tables) {
      await this.#withReplicationRoleReplica(async () => {
        await this.#pglite.exec(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);

        for (const insert of restore) {
          await this.#pglite.exec(insert);
        }

        if (!this.#hasSnapshot) return;

        const { rows: seqs } = await this.#pglite.query<{ name: string; value: string }>(
          `SELECT quote_literal(name) AS name, value::text AS value FROM ${SNAPSHOT_SCHEMA_IDENT}.__sequences`,
        );

        for (const { name, value } of seqs) {
          // Two-arg setval marks is_called = true: a sequence positioned via
          // setval(seq, n, false) before snapshotDb() restores one off (next
          // value n+1, not n). Pre-existing, accepted — capturing is_called
          // would cost a per-sequence query at snapshot time.
          await this.#pglite.exec(`SELECT setval(${name}, ${value})`);
        }
      });
    }

    // Everything DISCARD ALL does except DEALLOCATE ALL: named prepared
    // statements survive resets. User tables are only truncated, never
    // dropped, so retained statements revalidate transparently — this keeps
    // the bridge's prepared-statement cache warm across resetDb().
    await this.#pglite.exec(
      `CLOSE ALL;
       SET SESSION AUTHORIZATION DEFAULT;
       RESET ALL;
       UNLISTEN *;
       SELECT pg_advisory_unlock_all();
       DISCARD PLANS;
       DISCARD SEQUENCES;
       DISCARD TEMP`,
    );
  }

  /**
   * Build the per-table INSERT statements restoring the snapshot, from the
   * live catalog: stored generated columns are excluded (they recompute from
   * the live expression — the restore assumes the schema still matches the
   * snapshot), and `GENERATED ALWAYS` identity columns need
   * `OVERRIDING SYSTEM VALUE` to accept their seed ids —
   * `session_replication_role = replica` does not bypass identity
   * enforcement. A zero-column table has no `information_schema.columns`
   * rows — indistinguishable from a dropped one by columns alone, hence the
   * `to_regclass` probe — and falls back to the legacy `SELECT *` form,
   * which round-trips row multiplicity fine.
   *
   * Fails fast on structural drift: a source table or column dropped since
   * `snapshotDb()` throws here, before anything is truncated. (A dropped
   * column would otherwise vanish from the column list and restore a
   * silently partial seed.)
   */
  async #restorePlan(): Promise<string[]> {
    const { rows } = await this.#pglite.query<{
      snap_name_ident: string;
      qualified: string;
      table_exists: boolean;
      cols: string | null;
      needs_overriding: boolean;
      missing_cols: string | null;
    }>(
      `SELECT quote_ident(t.snap_name) AS snap_name_ident,
              quote_ident(t.source_schema) || '.' || quote_ident(t.source_table) AS qualified,
              to_regclass(quote_ident(t.source_schema) || '.' || quote_ident(t.source_table)) IS NOT NULL AS table_exists,
              string_agg(quote_ident(c.column_name), ', ' ORDER BY c.ordinal_position)
                FILTER (WHERE c.is_generated = 'NEVER') AS cols,
              COALESCE(bool_or(c.is_identity = 'YES' AND c.identity_generation = 'ALWAYS'), false) AS needs_overriding,
              (SELECT string_agg(quote_ident(sc.column_name), ', ' ORDER BY sc.ordinal_position)
                 FROM information_schema.columns sc
                WHERE sc.table_schema = ${SNAPSHOT_SCHEMA_LITERAL}
                  AND sc.table_name = t.snap_name
                  AND NOT EXISTS (SELECT 1 FROM information_schema.columns lc
                                   WHERE lc.table_schema = t.source_schema
                                     AND lc.table_name = t.source_table
                                     AND lc.column_name = sc.column_name)) AS missing_cols
       FROM ${SNAPSHOT_SCHEMA_IDENT}.__tables t
       LEFT JOIN information_schema.columns c
         ON c.table_schema = t.source_schema AND c.table_name = t.source_table
       GROUP BY t.snap_name, t.source_schema, t.source_table`,
    );

    return rows.map(
      ({ snap_name_ident, qualified, table_exists, cols, needs_overriding, missing_cols }) => {
        if (!table_exists) {
          throw new Error(
            `Snapshot source table ${qualified} no longer exists — the schema changed since snapshotDb(); re-run snapshotDb() after schema changes`,
          );
        }
        if (missing_cols !== null) {
          throw new Error(
            `Snapshot columns ${missing_cols} of ${qualified} no longer exist — the schema changed since snapshotDb(); re-run snapshotDb() after schema changes`,
          );
        }
        const snap = `${SNAPSHOT_SCHEMA_IDENT}.${snap_name_ident}`;
        return cols === null
          ? `INSERT INTO ${qualified} SELECT * FROM ${snap}`
          : `INSERT INTO ${qualified} (${cols})${needs_overriding ? ' OVERRIDING SYSTEM VALUE' : ''} SELECT ${cols} FROM ${snap}`;
      },
    );
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
   * Self-heal: external SQL (a caller's raw `DROP SCHEMA`, a
   * `prisma migrate reset`) may drop `_pglite_snapshot` out from under us.
   * Returns whether the schema actually exists right now, and clears
   * `#hasSnapshot` if it doesn't.
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
