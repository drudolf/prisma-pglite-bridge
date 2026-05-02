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
import type { PGlite } from '@electric-sql/pglite';

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
    throw new Error(
      `No migration.sql files found in ${options.migrationsPath}. Run \`prisma migrate dev\` to generate migration files.`,
    );
  }

  const migrationsPath = await getMigrationsPath(options.configRoot);
  if (migrationsPath) {
    const sql = readMigrationFiles(migrationsPath);
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
 * Apply pre-generated SQL to a PGlite instance.
 *
 * Runs the SQL through `pglite.exec(...)` directly, bypassing any bridge
 * pool. No schema engine, no WASM module, no diffing — useful when you
 * already have a `prisma/migrations` directory or pre-generated SQL.
 *
 * Pass the same PGlite instance you handed to {@link createPGliteBridge}
 * (i.e. `bridge.pglite`) — or any standalone `PGlite` you own.
 */
export const pushMigrations = async (
  pglite: PGlite,
  options: PushMigrationsOptions = {},
): Promise<PushMigrationsResult> => {
  const sql = await getMigrationSQL(options);
  const start = process.hrtime.bigint();
  try {
    await pglite.exec(sql);
  } catch (err) {
    const where = pglite.dataDir ? `PGlite(dataDir=${pglite.dataDir})` : 'in-memory PGlite';
    throw new Error(
      `Failed to apply schema SQL to ${where}. Check your schema or migration files.`,
      { cause: err },
    );
  }
  return { durationMs: Number(process.hrtime.bigint() - start) / 1e6 };
};
