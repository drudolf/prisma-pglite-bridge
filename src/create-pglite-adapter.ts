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

  /** The underlying PGlite instance for direct SQL, snapshots, or extensions. */
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
  }

  throw new Error(
    'No migration files found. Run `prisma migrate dev` to generate them, ' +
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

  const isInitialized = async () => {
    const { rows } = await pglite.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM (
         SELECT 1 FROM pg_tables WHERE schemaname = 'public'
         UNION ALL
         SELECT 1 FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid
           WHERE n.nspname = 'public' AND t.typtype = 'e'
         UNION ALL
         SELECT 1 FROM pg_namespace
           WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public')
       ) AS objects`,
    );
    return (rows[0]?.n ?? 0) > 0;
  };

  if (!options.dataDir || !(await isInitialized())) {
    const sql = await resolveSQL(options);
    try {
      await pglite.exec(sql);
    } catch (err) {
      throw new Error(
        'Failed to apply schema SQL to PGlite. Check your schema or migration files.',
        {
          cause: err,
        },
      );
    }
  }

  const adapter = new PrismaPg(pool);

  const escapeLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

  let cachedTables: string | null = null;
  let hasSnapshot = false;

  const discoverTables = async () => {
    if (cachedTables !== null) return cachedTables;
    const { rows } = await pglite.query<{ qualified: string }>(
      `SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
       FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
       AND schemaname != '${SNAPSHOT_SCHEMA}'
       AND tablename NOT LIKE '_prisma%'`,
    );
    cachedTables = rows.length > 0 ? rows.map((r) => r.qualified).join(', ') : '';
    return cachedTables;
  };

  const snapshotDb: SnapshotDbFn = async () => {
    await pglite.exec(`DROP SCHEMA IF EXISTS "${SNAPSHOT_SCHEMA}" CASCADE`);
    await pglite.exec(`CREATE SCHEMA "${SNAPSHOT_SCHEMA}"`);

    const { rows: tables } = await pglite.query<{
      schemaname: string;
      tablename: string;
    }>(
      `SELECT quote_ident(schemaname) AS schemaname, quote_ident(tablename) AS tablename
       FROM pg_tables
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
       AND schemaname != '${SNAPSHOT_SCHEMA}'
       AND tablename NOT LIKE '_prisma%'`,
    );

    await pglite.exec(
      `CREATE TABLE "${SNAPSHOT_SCHEMA}".__tables (snap_name text, source_schema text, source_table text)`,
    );

    for (let i = 0; i < tables.length; i++) {
      const { schemaname, tablename } = tables[i]!;
      const snapName = `_snap_${i}`;
      await pglite.exec(
        `CREATE TABLE "${SNAPSHOT_SCHEMA}"."${snapName}" AS SELECT * FROM ${schemaname}.${tablename}`,
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
      await pglite.exec(`INSERT INTO "${SNAPSHOT_SCHEMA}".__sequences VALUES (${name}, ${value})`);
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
          source_schema: string;
          source_table: string;
        }>(`SELECT snap_name, source_schema, source_table FROM "${SNAPSHOT_SCHEMA}".__tables`);

        for (const { snap_name, source_schema, source_table } of snapshotTables) {
          await pglite.exec(
            `INSERT INTO ${source_schema}.${source_table} SELECT * FROM "${SNAPSHOT_SCHEMA}"."${snap_name}"`,
          );
        }
      } finally {
        await pglite.exec('SET session_replication_role = DEFAULT');
      }

      const { rows: seqs } = await pglite.query<{ name: string; value: string }>(
        `SELECT quote_literal(name) AS name, value::text AS value FROM "${SNAPSHOT_SCHEMA}".__sequences`,
      );

      for (const { name, value } of seqs) {
        await pglite.exec(`SELECT setval(${name}, ${value})`);
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
