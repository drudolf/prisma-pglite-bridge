/**
 * Creates a Prisma adapter backed by in-process PGlite.
 *
 * No TCP, no Docker, no worker threads — everything runs in the same process.
 * Works for testing, development, seeding, and scripts.
 *
 * ```typescript
 * import { createPgliteAdapter } from 'prisma-pglite-bridge';
 * import { PrismaClient } from '@prisma/client';
 *
 * const { adapter, resetDb } = await createPgliteAdapter();
 * const prisma = new PrismaClient({ adapter });
 *
 * beforeEach(() => resetDb());
 * ```
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPool } from './create-pool.ts';

const SNAPSHOT_SCHEMA = '_pglite_snapshot';
const SENTINEL_SCHEMA = '_pglite_bridge';
const SENTINEL_TABLE = '__initialized';
const SENTINEL_MARKER = 'prisma-pglite-bridge:init:v1';

const USER_TABLES_WHERE = `schemaname NOT IN ('pg_catalog', 'information_schema')
       AND schemaname != '${SNAPSHOT_SCHEMA}'
       AND schemaname != '${SENTINEL_SCHEMA}'
       AND tablename NOT LIKE '_prisma%'`;

const escapeLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

const isValidSentinelRow = (rows: Array<{ marker: string; version: number }>) =>
  rows.length === 1 && rows[0]?.marker === SENTINEL_MARKER && rows[0]?.version === 1;

export interface CreatePgliteAdapterOptions {
  /** Path to prisma/migrations/ directory (auto-discovered via prisma.config.ts if omitted) */
  migrationsPath?: string;

  /** Pre-generated SQL to apply instead of auto-generating from schema */
  sql?: string;

  /** Root directory for prisma.config.ts discovery (default: process.cwd()). Set this in monorepos where tests run from the workspace root. */
  configRoot?: string;

  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

  /** PGlite extensions (e.g., `{ uuid_ossp: uuidOssp() }`) */
  extensions?: import('@electric-sql/pglite').Extensions;

  /** Maximum pool connections (default: 5) */
  max?: number;
}

/** Clear all user tables. Call in `beforeEach` for per-test isolation. */
export type ResetDbFn = () => Promise<void>;

export type SnapshotDbFn = () => Promise<void>;

export type ResetSnapshotFn = () => Promise<void>;

export interface PgliteAdapter {
  /** Prisma adapter — pass directly to `new PrismaClient({ adapter })` */
  adapter: PrismaPg;

  /**
   * The underlying PGlite instance for direct SQL, snapshots, or extensions.
   *
   * @remarks
   * Direct `pglite.exec()` / `pglite.query()` calls bypass the pool's
   * {@link SessionLock}. Avoid mixing direct calls with Prisma operations
   * inside a transaction — use them only for setup, teardown, or utilities
   * that run outside active Prisma transactions.
   */
  pglite: import('@electric-sql/pglite').PGlite;

  /** Clear all user tables. Call in `beforeEach` for per-test isolation. */
  resetDb: ResetDbFn;

  /** Snapshot current DB state. Subsequent `resetDb` calls restore to this snapshot. */
  snapshotDb: SnapshotDbFn;

  /** Discard the current snapshot. Subsequent `resetDb` calls truncate to empty. */
  resetSnapshot: ResetSnapshotFn;

  /** Shut down pool and PGlite. Not needed in tests (process exit handles it). */
  close: () => Promise<void>;
}

/**
 * Discover the migrations directory via Prisma's config API.
 * Uses the same resolution as `prisma migrate dev` — reads prisma.config.ts,
 * resolves paths relative to config file location.
 *
 * Returns null if @prisma/config is not available or config cannot be loaded.
 */
const discoverMigrationsPath = async (configRoot?: string): Promise<string | null> => {
  try {
    const { loadConfigFromFile } = await import('@prisma/config');
    const { config, error } = await loadConfigFromFile({ configRoot: configRoot ?? process.cwd() });
    if (error) return null;

    // Explicit migrations path from prisma.config.ts
    if (config.migrations?.path) return config.migrations.path;

    // Fallback: Prisma convention is {schemaDir}/migrations
    const schemaPath = config.schema;
    if (schemaPath) return join(dirname(schemaPath), 'migrations');

    return null;
  } catch {
    return null;
  }
};

/**
 * Read migration SQL files from a migrations directory in directory order.
 * Returns null if the directory doesn't exist or has no migration files.
 */
const tryReadMigrationFiles = (migrationsPath: string): string | null => {
  if (!existsSync(migrationsPath)) return null;

  const dirs = readdirSync(migrationsPath)
    .filter((d) => statSync(join(migrationsPath, d)).isDirectory())
    .sort();

  const sqlParts: string[] = [];
  for (const dir of dirs) {
    const sqlPath = join(migrationsPath, dir, 'migration.sql');
    if (existsSync(sqlPath)) {
      sqlParts.push(readFileSync(sqlPath, 'utf8'));
    }
  }

  return sqlParts.length > 0 ? sqlParts.join('\n') : null;
};

/**
 * Resolve schema SQL. Priority:
 *   1. Explicit `sql` option — use directly
 *   2. Explicit `migrationsPath` — read migration files
 *   3. Auto-discovered migrations (via prisma.config.ts) — read migration files
 *   4. Error — tell the user to generate migration files
 */
const resolveSQL = async (options: CreatePgliteAdapterOptions): Promise<string> => {
  if (options.sql) return options.sql;

  // Explicit migrationsPath
  if (options.migrationsPath) {
    const sql = tryReadMigrationFiles(options.migrationsPath);
    if (sql) return sql;
    throw new Error(
      `No migration.sql files found in ${options.migrationsPath}. Run \`prisma migrate dev\` to generate migration files.`,
    );
  }

  // Auto-discover via Prisma config
  const migrationsPath = await discoverMigrationsPath(options.configRoot);

  if (migrationsPath) {
    const sql = tryReadMigrationFiles(migrationsPath);
    if (sql) return sql;

    throw new Error(
      `No migration.sql files found in auto-discovered path ${migrationsPath}. ` +
        'Run `prisma migrate dev` to generate migration files, ' +
        'or pass pre-generated SQL via the `sql` option.',
    );
  }

  if (options.configRoot) {
    throw new Error(
      `prisma.config.ts loaded from configRoot (${options.configRoot}) but no schema ` +
        'or migrations path could be resolved. Ensure your config specifies a schema path, ' +
        'or pass pre-generated SQL via the `sql` option.',
    );
  }

  throw new Error(
    'No migration files found and no prisma.config.ts could be loaded. ' +
      'Run `prisma migrate dev` to generate them, ' +
      'or pass pre-generated SQL via the `sql` option.',
  );
};

/**
 * Creates a Prisma adapter backed by an in-process PGlite instance.
 *
 * Applies the schema and returns a ready-to-use adapter + a `resetDb`
 * function for clearing tables between tests.
 */
export const createPgliteAdapter = async (
  options: CreatePgliteAdapterOptions = {},
): Promise<PgliteAdapter> => {
  const {
    pool,
    pglite,
    close: poolClose,
  } = await createPool({
    dataDir: options.dataDir,
    extensions: options.extensions,
    max: options.max,
  });

  const sentinelStatements = [
    `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
    `CREATE TABLE IF NOT EXISTS "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
    `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES (${escapeLiteral(SENTINEL_MARKER)}, 1) ON CONFLICT (marker) DO NOTHING`,
  ];

  const collisionError = () =>
    `"${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" exists but is not owned by prisma-pglite-bridge. ` +
    `The "${SENTINEL_SCHEMA}" schema is reserved for library metadata.`;

  const writeSentinel = async () => {
    let committed = false;
    try {
      await pglite.exec(`BEGIN;\n${sentinelStatements.join(';\n')}`);

      const { rows } = await pglite.query<{ marker: string; version: number }>(
        `SELECT marker, version FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}"`,
      );
      if (!isValidSentinelRow(rows)) throw new Error(collisionError());
      await pglite.exec('COMMIT');
      committed = true;
    } catch (err) {
      if (!committed) await pglite.exec('ROLLBACK');
      throw err instanceof Error && err.message === collisionError()
        ? err
        : new Error(collisionError(), { cause: err });
    }
  };

  const isInitialized = async () => {
    const { rows: tableExists } = await pglite.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_tables
           WHERE schemaname = '${SENTINEL_SCHEMA}' AND tablename = '${SENTINEL_TABLE}'
       ) AS found`,
    );

    if (tableExists[0]?.found) {
      try {
        const { rows: allRows } = await pglite.query<{ marker: string; version: number }>(
          `SELECT marker, version FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}"`,
        );
        if (isValidSentinelRow(allRows)) return true;
      } catch {
        // Table has incompatible columns — fall through to collision error
      }

      throw new Error(collisionError());
    }

    const { rows: schemaExists } = await pglite.query<{ found: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_namespace WHERE nspname = '${SENTINEL_SCHEMA}'
       ) AS found`,
    );
    if (schemaExists[0]?.found) {
      throw new Error(
        `Schema "${SENTINEL_SCHEMA}" exists but is not owned by prisma-pglite-bridge. ` +
          `The "${SENTINEL_SCHEMA}" schema is reserved for library metadata.`,
      );
    }

    const { rows: legacy } = await pglite.query<{ initialized: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
           WHERE n.nspname = 'public'
         UNION ALL
         SELECT 1 FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid
           WHERE n.nspname = 'public' AND t.typtype NOT IN ('b', 'p')
         UNION ALL
         SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
           WHERE n.nspname = 'public'
         UNION ALL
         SELECT 1 FROM pg_namespace
           WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public')
       ) AS initialized`,
    );
    if (legacy[0]?.initialized) {
      await writeSentinel();
      return true;
    }

    return false;
  };

  if (!options.dataDir || !(await isInitialized())) {
    const sql = await resolveSQL(options);
    const isMigrationSQL = !options.sql;

    if (isMigrationSQL) {
      let committed = false;
      try {
        await pglite.exec(`BEGIN;\n${sql};\n${sentinelStatements.join(';\n')}`);

        const { rows: verify } = await pglite.query<{ marker: string; version: number }>(
          `SELECT marker, version FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}"`,
        );
        if (!isValidSentinelRow(verify)) throw new Error(collisionError());
        await pglite.exec('COMMIT');
        committed = true;
      } catch (err) {
        if (!committed) await pglite.exec('ROLLBACK');
        if (err instanceof Error && err.message === collisionError()) throw err;
        throw new Error(
          'Failed to apply schema SQL to PGlite. Check your schema or migration files.',
          { cause: err },
        );
      }
    } else {
      try {
        await pglite.exec(sql);
      } catch (err) {
        throw new Error(
          'Failed to apply schema SQL to PGlite. Check your schema or migration files.',
          { cause: err },
        );
      }
      await writeSentinel();
    }
  }

  const adapter = new PrismaPg(pool);

  let cachedTables: string | null = null;
  let hasSnapshot = false;

  const discoverTables = async () => {
    if (cachedTables !== null) return cachedTables;
    const { rows } = await pglite.query<{ qualified: string }>(
      `SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
       FROM pg_tables
       WHERE ${USER_TABLES_WHERE}`,
    );
    cachedTables = rows.length > 0 ? rows.map((r) => r.qualified).join(', ') : '';
    return cachedTables;
  };

  const snapshotDb: SnapshotDbFn = async () => {
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

  const resetSnapshot: ResetSnapshotFn = async () => {
    hasSnapshot = false;
    await pglite.exec(`DROP SCHEMA IF EXISTS "${SNAPSHOT_SCHEMA}" CASCADE`);
  };

  const resetDb = async () => {
    cachedTables = null;
    const tables = await discoverTables();

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

    await pglite.exec('RESET ALL');
    await pglite.exec('DEALLOCATE ALL');
  };

  return { adapter, pglite, resetDb, snapshotDb, resetSnapshot, close: poolClose };
};
