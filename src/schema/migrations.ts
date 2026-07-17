/**
 * Apply pre-generated SQL (raw or from `prisma/migrations/`) to a PGlite
 * database. Sibling of {@link pushSchema} — both populate a database, but
 * `pushMigrations` takes a `PGlite` directly and bypasses
 * `@prisma/schema-engine-wasm`. Use when you already have generated SQL
 * and don't need a live schema diff.
 *
 * @example
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { pushMigrations } from 'prisma-pglite-bridge';
 *
 * const pglite = new PGlite();
 * await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
 * ```
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import { PgBridgeError } from '../errors.ts';

export interface PushMigrationsOptions {
  /** Pre-generated SQL to apply directly. */
  sql?: string;
  /** Path to a `prisma/migrations/` directory (auto-discovered via prisma.config.ts if omitted). */
  migrationsPath?: string;
  /** Root for prisma.config.ts discovery (default: process.cwd()). Set in monorepos where tests run from the workspace root. */
  configRoot?: string;
}

export interface PushMigrationsResult {
  /** Wall-clock time of the SQL apply, in milliseconds. */
  durationMs: number;
}

/**
 * Resolve the migrations directory via Prisma's config API. Uses the same
 * resolution as `prisma migrate dev` — reads prisma.config.ts and resolves
 * paths relative to the config file's location.
 *
 * Returns undefined if @prisma/config is not available or the config
 * cannot be loaded.
 */
export const getMigrationsPath = async (configRoot?: string): Promise<string | undefined> => {
  try {
    const { loadConfigFromFile } = await import('@prisma/config');
    const { config, error } = await loadConfigFromFile({ configRoot: configRoot ?? process.cwd() });
    if (error) return undefined;

    if (config.migrations?.path) return config.migrations.path;

    const schemaPath = config.schema;
    if (schemaPath) return join(dirname(schemaPath), 'migrations');

    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read and concatenate every `migration.sql` under a migrations directory in
 * directory order. Returns undefined if the directory doesn't exist or has no
 * migration files.
 */
export const readMigrationFiles = (migrationsPath: string): string | undefined => {
  if (!existsSync(migrationsPath)) return undefined;

  const dirs = readdirSync(migrationsPath)
    .filter((directory) => statSync(join(migrationsPath, directory)).isDirectory())
    .sort();

  const sqlParts: string[] = [];
  for (const directory of dirs) {
    const sqlPath = join(migrationsPath, directory, 'migration.sql');
    if (existsSync(sqlPath)) {
      sqlParts.push(readFileSync(sqlPath, 'utf8'));
    }
  }

  return sqlParts.length > 0 ? sqlParts.join('\n') : undefined;
};

/**
 * Resolve schema SQL from {@link PushMigrationsOptions}. Priority:
 *   1. Explicit `sql`
 *   2. Explicit `migrationsPath` — read migration files
 *   3. Auto-discovered migrations via prisma.config.ts
 *   4. Throw — tell the caller to generate migration files
 */
export const getMigrationSQL = async (options: PushMigrationsOptions): Promise<string> => {
  if (options.sql) return options.sql;

  if (options.migrationsPath) {
    const sql = readMigrationFiles(options.migrationsPath);
    if (sql) return sql;
    throw new PgBridgeError(
      'MIGRATIONS_UNAVAILABLE',
      `No migration.sql files found in ${options.migrationsPath}. Run \`prisma migrate dev\` to generate migration files.`,
    );
  }

  const migrationsPath = await getMigrationsPath(options.configRoot);
  if (migrationsPath) {
    const sql = readMigrationFiles(migrationsPath);
    if (sql) return sql;

    throw new PgBridgeError(
      'MIGRATIONS_UNAVAILABLE',
      `No migration.sql files found in auto-discovered path ${migrationsPath}. ` +
        'Run `prisma migrate dev` to generate migration files, ' +
        'or pass pre-generated SQL via the `sql` option.',
    );
  }

  if (options.configRoot) {
    throw new PgBridgeError(
      'MIGRATIONS_UNAVAILABLE',
      `prisma.config.ts loaded from configRoot (${options.configRoot}) but no schema ` +
        'or migrations path could be resolved. Ensure your config specifies a schema path, ' +
        'or pass pre-generated SQL via the `sql` option.',
    );
  }

  throw new PgBridgeError(
    'MIGRATIONS_UNAVAILABLE',
    'No migration files found and no prisma.config.ts could be loaded. ' +
      'Run `prisma migrate dev` to generate them, ' +
      'or pass pre-generated SQL via the `sql` option.',
  );
};

/**
 * Apply pre-generated SQL to a PGlite instance.
 *
 * Runs the SQL through `pglite.exec(...)` directly, bypassing any bridge
 * pool. No schema engine, no WASM module, no diffing — useful when you
 * already have a `prisma/migrations` directory or pre-generated SQL.
 *
 * Pass the same PGlite instance you handed to {@link PGliteBridge}
 * (i.e. `bridge.pglite`) — or any standalone `PGlite` you own.
 *
 * @throws {PgBridgeError} `MIGRATIONS_UNAVAILABLE` when no usable
 *   migrations source resolves (no `sql`, no `migration.sql` files, no
 *   loadable `prisma.config.ts`); `MIGRATIONS_APPLY_FAILED` (with `cause`)
 *   when applying the SQL fails.
 */
export const pushMigrations = async (
  pglite: PGlite | PGliteInterface,
  options: PushMigrationsOptions = {},
): Promise<PushMigrationsResult> => {
  const sql = await getMigrationSQL(options);
  const start = process.hrtime.bigint();
  try {
    await pglite.exec(sql);
  } catch (err) {
    const where = pglite.dataDir ? `PGlite(dataDir=${pglite.dataDir})` : 'in-memory PGlite';
    throw new PgBridgeError(
      'MIGRATIONS_APPLY_FAILED',
      `Failed to apply schema SQL to ${where}. Check your schema or migration files.`,
      { cause: err },
    );
  }
  return { durationMs: Number(process.hrtime.bigint() - start) / 1e6 };
};

/**
 * Returns `true` when the `_prisma_migrations` table exists and has at
 * least one row with `finished_at IS NOT NULL`. Useful as a "first run"
 * guard for persistent dataDirs:
 *
 * ```typescript
 * if (!(await hasMigrations(pglite))) {
 *   await pushMigrations(pglite, { migrationsPath: './prisma/migrations' });
 * }
 * ```
 *
 * Awaits `pglite.waitReady` implicitly via `pglite.query(...)`. Detects only
 * Prisma-managed migrations — `pushSchema` (WASM diff) does not populate
 * `_prisma_migrations`, so this returns `false` for adapter-applied schemas.
 */
export const hasMigrations = async (pglite: PGlite | PGliteInterface): Promise<boolean> => {
  const { rows } = await pglite.query<{ exists: boolean }>(
    `SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return false;

  const { rows: applied } = await pglite.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
  );
  return (applied[0]?.count ?? 0) > 0;
};

/**
 * Returns `true` when the `public` schema contains at least one user table.
 * Broader sibling of {@link hasMigrations} — fires for any DDL, regardless of
 * whether it came from {@link pushMigrations}, {@link pushSchema}, or hand-rolled
 * SQL. Use as a "first run" guard when you are not using a Prisma migrations
 * directory:
 *
 * ```typescript
 * if (!(await hasSchema(pglite))) {
 *   await pushSchema(bridge.adapter, { schema });
 * }
 * ```
 *
 * Awaits `pglite.waitReady` implicitly via `pglite.query(...)`. The internal
 * `_pglite_snapshot` schema used by `bridge.snapshotDb()` is excluded — only
 * the `public` schema is inspected.
 */
export const hasSchema = async (pglite: PGlite | PGliteInterface): Promise<boolean> => {
  const { rows } = await pglite.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
     ) AS exists`,
  );
  return rows[0]?.exists === true;
};
