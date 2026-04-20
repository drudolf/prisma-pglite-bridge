import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface MigrationsOptions {
  /** Path to prisma/migrations/ directory (auto-discovered via prisma.config.ts if omitted) */
  migrationsPath?: string;

  /** Pre-generated SQL to apply instead of auto-generating from schema */
  sql?: string;

  /** Root directory for prisma.config.ts discovery (default: process.cwd()). Set this in monorepos where tests run from the workspace root. */
  configRoot?: string;
}

/**
 * Get the migrations directory via Prisma's config API.
 * Uses the same resolution as `prisma migrate dev` — reads prisma.config.ts,
 * resolves paths relative to config file location.
 *
 * Returns undefined if @prisma/config is not available or config cannot be loaded.
 */
export const getMigrationsPath = async (configRoot?: string): Promise<string | undefined> => {
  try {
    const { loadConfigFromFile } = await import('@prisma/config');
    const { config, error } = await loadConfigFromFile({ configRoot: configRoot ?? process.cwd() });
    if (error) return undefined;

    // Explicit migrations path from prisma.config.ts
    if (config.migrations?.path) return config.migrations.path;

    // Fallback: Prisma convention is {schemaDir}/migrations
    const schemaPath = config.schema;
    if (schemaPath) return join(dirname(schemaPath), 'migrations');

    return undefined;
  } catch {
    return undefined;
  }
};

/**
 * Read migration SQL files from a migrations directory in directory order.
 * Returns undefined if the directory doesn't exist or has no migration files.
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
 * Get schema SQL. Priority:
 *   1. Explicit `sql` option — use directly
 *   2. Explicit `migrationsPath` — read migration files
 *   3. Auto-discovered migrations (via prisma.config.ts) — read migration files
 *   4. Error — tell the user to generate migration files
 */
export const getMigrationSQL = async (options: MigrationsOptions): Promise<string> => {
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
