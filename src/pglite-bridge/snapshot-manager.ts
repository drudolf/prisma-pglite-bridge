import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import { PgBridgeError } from '../errors.ts';
import { quoteIdent } from '../utils/quote-ident.ts';

const SNAPSHOT_SCHEMA = '_pglite_snapshot';
/** Rebuild staging schema — swapped into place atomically on success. */
const SNAPSHOT_SCHEMA_NEW = '_pglite_snapshot_new';

const SYSTEM_SCHEMA_EXCLUSION = `schemaname NOT IN ('pg_catalog', 'information_schema')
       AND schemaname != '${SNAPSHOT_SCHEMA}'
       AND schemaname != '${SNAPSHOT_SCHEMA_NEW}'`;

const USER_TABLES_WHERE = `${SYSTEM_SCHEMA_EXCLUSION}
       AND tablename NOT LIKE '\\_prisma%'`;

/**
 * Everything `DISCARD ALL` does except `DEALLOCATE ALL`: named prepared
 * statements survive resets. User tables are only truncated, never dropped,
 * so retained statements revalidate transparently — this keeps the bridge's
 * prepared-statement cache warm across `resetDb()`.
 */
const SESSION_SCRUB_SQL = `CLOSE ALL;
       SET SESSION AUTHORIZATION DEFAULT;
       RESET ALL;
       UNLISTEN *;
       SELECT pg_advisory_unlock_all();
       DISCARD PLANS;
       DISCARD SEQUENCES;
       DISCARD TEMP`;

export interface ResetDbOptions {
  /**
   * Also reset session state (`SET`s, `LISTEN`s, cursors, temp tables,
   * advisory locks) after restoring the data. Default `true` — the bridge
   * owns its session. `PGliteServer` passes `false`: its session belongs to
   * the connected app and a scrub would silently reconfigure it.
   */
  scrubSession?: boolean;
}

const SNAPSHOT_SCHEMA_IDENT = quoteIdent(SNAPSHOT_SCHEMA);
const SNAPSHOT_SCHEMA_NEW_IDENT = quoteIdent(SNAPSHOT_SCHEMA_NEW);
// PGlite has no background checkpointer. Repeated restores otherwise retain
// their WAL files in memory even when the live database stays the same size.
const CHECKPOINT_INTERVAL_BYTES = 64n * 1024n * 1024n;
// Direct field access avoids a subquery/Function Scan. Compare in SQL so
// NUMERIC parsers cannot affect the decision and only a boolean crosses to JS.
const WAL_STATE_SQL = `CASE WHEN pg_has_role(current_user, 'pg_checkpoint', 'USAGE')
       THEN pg_wal_lsn_diff(pg_current_wal_insert_lsn(), (pg_control_checkpoint()).redo_lsn)
            >= ${CHECKPOINT_INTERVAL_BYTES}
       ELSE false END AS checkpoint_due`;
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
 * shared-instance advisory warning). Whether a snapshot exists is read
 * from the database on every reset, never cached, so two managers over one
 * PGlite (a bridge and a `PGliteServer`) always agree.
 *
 * @internal
 */
export class SnapshotManager {
  readonly #pglite: PGlite | PGliteInterface;
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
    const startup = await this.#pglite.exec(
      `DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_NEW_IDENT} CASCADE; SELECT ${WAL_STATE_SQL}`,
    );
    await this.#checkpointIfNeeded(startup.at(-1)?.rows[0]);

    try {
      await this.#pglite.exec('BEGIN');
      await this.#pglite.exec(`CREATE SCHEMA ${SNAPSHOT_SCHEMA_NEW_IDENT}`);

      // Build the mapping in SQL instead of issuing one parameterized
      // INSERT per table. Keep its existing text-column layout so snapshots
      // remain readable by other managers and earlier bridge versions.
      await this.#pglite.exec(
        `CREATE TABLE ${SNAPSHOT_SCHEMA_NEW_IDENT}.__tables AS
         SELECT '_snap_' || (row_number() OVER (ORDER BY schemaname, tablename) - 1) AS snap_name,
                schemaname::text AS source_schema, tablename::text AS source_table
         FROM pg_tables
         WHERE ${USER_TABLES_WHERE}`,
      );

      const { rows: tables } = await this.#pglite.query<{
        snap_name_ident: string;
        qualified: string;
      }>(
        `SELECT quote_ident(snap_name) AS snap_name_ident,
                quote_ident(source_schema) || '.' || quote_ident(source_table) AS qualified
         FROM ${SNAPSHOT_SCHEMA_NEW_IDENT}.__tables
         ORDER BY source_schema, source_table`,
      );

      if (tables.length > 0) {
        // One protocol call copies every table. Each physical table is listed
        // separately, including partition leaves and inheritance children;
        // ONLY avoids capturing descendant rows a second time in the parent.
        // A failed copy aborts the enclosing transaction, including earlier
        // copies in this batch, and leaves the old snapshot intact.
        await this.#pglite.exec(
          tables
            .map(
              ({ snap_name_ident, qualified }) =>
                `CREATE TABLE ${SNAPSHOT_SCHEMA_NEW_IDENT}.${snap_name_ident} AS SELECT * FROM ONLY ${qualified}`,
            )
            .join(';\n'),
        );
      }

      const { rows: seqs } = await this.#pglite.query<{ name: string; qualified: string }>(
        `SELECT quote_literal(quote_ident(schemaname) || '.' || quote_ident(sequencename)) AS name,
                quote_ident(schemaname) || '.' || quote_ident(sequencename) AS qualified
         FROM pg_sequences
         WHERE ${SYSTEM_SCHEMA_EXCLUSION}`,
      );

      await this.#pglite.exec(
        `CREATE TABLE ${SNAPSHOT_SCHEMA_NEW_IDENT}.__sequences (name text, value bigint, is_called boolean)`,
      );
      if (seqs.length > 0) {
        // pg_sequences hides the value of unconsumed sequences and omits
        // is_called. Read both directly, keeping bigint values inside SQL.
        await this.#pglite.exec(
          seqs
            .map(
              ({ name, qualified }) =>
                `INSERT INTO ${SNAPSHOT_SCHEMA_NEW_IDENT}.__sequences SELECT ${name}, last_value, is_called FROM ${qualified}`,
            )
            .join(';\n'),
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
      // rolled-back transaction leaves the previous snapshot untouched.
      await this.#pglite
        .exec('ROLLBACK')
        .then(() => this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_NEW_IDENT} CASCADE`))
        .catch(() => {});
      throw err;
    }
  }

  /** Drop the saved snapshot (and any interrupted-rebuild staging schema),
   *  reverting `resetDb` to plain truncation. */
  resetSnapshot(): Promise<void> {
    return this.#serialize(() => this.#resetSnapshot());
  }

  async #resetSnapshot(): Promise<void> {
    await this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_IDENT} CASCADE`);
    await this.#pglite.exec(`DROP SCHEMA IF EXISTS ${SNAPSHOT_SCHEMA_NEW_IDENT} CASCADE`);
  }

  /**
   * Truncate all user tables. If a snapshot exists, restore its contents and
   * sequence values afterwards — in one transaction, so a failed restore
   * leaves the data untouched and the FK/trigger bypass
   * (`SET LOCAL session_replication_role`) never outlives it. Then, unless
   * `scrubSession: false`, reset session state — everything `DISCARD ALL`
   * covers except `DEALLOCATE ALL`, so named prepared statements survive.
   *
   * Requires the live schema to still structurally match the snapshot:
   * a source table or column dropped since `snapshotDb()` fails fast
   * (before anything is truncated), and other column drift surfaces as an
   * insert error against the snapshot table.
   */
  resetDb(options: ResetDbOptions = {}): Promise<void> {
    return this.#serialize(() => this.#resetDb(options.scrubSession !== false));
  }

  async #resetDb(scrubSession: boolean): Promise<void> {
    const { hasSnapshot, tables } = await this.#prepareReset();

    // Plan the restore before truncating — and even when no live user
    // table is left to truncate — so schema drift since snapshotDb()
    // fails loudly with the data still intact.
    const restore = hasSnapshot ? await this.#restorePlan() : [];

    if (tables || hasSnapshot) {
      // One protocol call for the entire restore, independent of table or
      // sequence count. Keep the session scrub separate: it must run after
      // the restore commits. Any SQL failure aborts before COMMIT and the
      // catch rolls back all table changes.
      const statements = ['BEGIN', 'SET LOCAL session_replication_role = replica'];
      if (tables) statements.push(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
      statements.push(...restore);
      if (hasSnapshot) {
        // A persisted snapshot from an older bridge has no is_called column;
        // its two-argument setval semantics mean true. New snapshots retain
        // the flag, including never-used standalone sequences without tables.
        statements.push(
          `SELECT setval(name::regclass, value, COALESCE((to_jsonb(s)->>'is_called')::boolean, true))
           FROM ${SNAPSHOT_SCHEMA_IDENT}.__sequences s`,
        );
      }
      statements.push('COMMIT');
      try {
        await this.#pglite.exec(statements.join(';\n'));
      } catch (err) {
        await this.#pglite.exec('ROLLBACK').catch(() => {});
        throw err;
      }
    }

    if (scrubSession) await this.#pglite.exec(SESSION_SCRUB_SQL);
  }

  /**
   * Build the per-table INSERT statements restoring the snapshot, from the
   * live catalog: stored generated columns are excluded (they recompute from
   * the live expression — the restore assumes the schema still matches the
   * snapshot), and `GENERATED ALWAYS` identity columns need
   * `OVERRIDING SYSTEM VALUE` to accept their seed ids —
   * `session_replication_role = replica` does not bypass identity
   * enforcement. A zero-column table has no user `pg_attribute`
   * rows — indistinguishable from a dropped one by columns alone, hence the
   * `to_regclass` probe — and falls back to the legacy `SELECT *` form,
   * which round-trips row multiplicity fine.
   *
   * Read pg_attribute directly: information_schema.columns expands domain,
   * type, collation, and privilege joins that this plan never uses. This
   * runs on every reset, so that view's planning cost alone can dominate a
   * small test database. Resolve relation OIDs anew to detect schema drift.
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
      `WITH tables AS (
         SELECT t.*,
                to_regclass(quote_ident(t.source_schema) || '.' || quote_ident(t.source_table)) AS source_oid,
                to_regclass(${SNAPSHOT_SCHEMA_LITERAL} || '.' || quote_ident(t.snap_name)) AS snap_oid
         FROM ${SNAPSHOT_SCHEMA_IDENT}.__tables t
       )
       SELECT quote_ident(t.snap_name) AS snap_name_ident,
              quote_ident(t.source_schema) || '.' || quote_ident(t.source_table) AS qualified,
              t.source_oid IS NOT NULL AS table_exists,
              string_agg(quote_ident(c.attname), ', ' ORDER BY c.attnum)
                FILTER (WHERE c.attgenerated = '') AS cols,
              COALESCE(bool_or(c.attidentity = 'a'), false) AS needs_overriding,
              (SELECT string_agg(quote_ident(sc.attname), ', ' ORDER BY sc.attnum)
                 FROM pg_catalog.pg_attribute sc
                WHERE sc.attrelid = t.snap_oid AND sc.attnum > 0 AND NOT sc.attisdropped
                  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute lc
                                   WHERE lc.attrelid = t.source_oid
                                     AND lc.attnum > 0 AND NOT lc.attisdropped
                                     AND lc.attname = sc.attname)) AS missing_cols
       FROM tables t
       LEFT JOIN pg_catalog.pg_attribute c
         ON c.attrelid = t.source_oid AND c.attnum > 0 AND NOT c.attisdropped
       GROUP BY t.snap_name, t.source_schema, t.source_table, t.source_oid, t.snap_oid`,
    );

    return rows.map(
      ({ snap_name_ident, qualified, table_exists, cols, needs_overriding, missing_cols }) => {
        if (!table_exists) {
          throw new PgBridgeError(
            'SNAPSHOT_INVALID',
            `Snapshot source table ${qualified} no longer exists — the schema changed since snapshotDb(); re-run snapshotDb() after schema changes`,
          );
        }
        if (missing_cols !== null) {
          throw new PgBridgeError(
            'SNAPSHOT_INVALID',
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

  /**
   * Checkpoint before changing snapshot/live data, never inside its transaction:
   * a maintenance failure must leave the prior state intact and remain retryable.
   * The probe shares a metadata call. A large operation's WAL is reclaimed
   * on a later snapshot/reset, not mid-query.
   * This is an interval, not a memory cap (WAL recycling and live data also count).
   */
  async #checkpointIfNeeded(state: Record<string, unknown> | undefined): Promise<void> {
    if (state?.checkpoint_due === true) await this.#pglite.exec('CHECKPOINT');
  }

  /**
   * Read snapshot presence, checkpoint state, and user tables in one exec call.
   * Both SELECTs finish before CHECKPOINT, outside the restore transaction.
   * Read the catalog on every reset. External SQL (a caller's raw `DROP SCHEMA`, a
   * `prisma migrate reset`) may drop it, and another manager over the same
   * PGlite may create it; caching either answer would desynchronize them.
   */
  async #prepareReset(): Promise<{ hasSnapshot: boolean; tables: string }> {
    const [state, tableList] = await this.#pglite.exec(
      `SELECT to_regnamespace(${SNAPSHOT_SCHEMA_LITERAL}) IS NOT NULL AS exists,
              ${WAL_STATE_SQL};
       SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
       FROM pg_tables
       WHERE ${USER_TABLES_WHERE}`,
    );
    await this.#checkpointIfNeeded(state?.rows[0]);
    return {
      hasSnapshot: state?.rows[0]?.exists === true,
      tables: tableList?.rows.map((row) => row.qualified).join(', ') ?? '',
    };
  }
}
