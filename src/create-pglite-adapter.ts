/**
 * Creates a Prisma adapter backed by in-process PGlite.
 *
 * No TCP, no Docker, no worker threads — everything runs in the same process.
 * Works for testing, development, seeding, and scripts.
 *
 * ```typescript
 * import { createPgliteAdapter } from 'prisma-enlite';
 * import { PrismaClient } from '@prisma/client';
 *
 * const { adapter, resetDb } = await createPgliteAdapter();
 * const prisma = new PrismaClient({ adapter });
 *
 * beforeEach(() => resetDb());
 * ```
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { createPool } from './create-pool.ts';

export interface CreatePgliteAdapterOptions {
  /** Path to schema.prisma (auto-discovered via prisma.config.ts if omitted) */
  schemaPath?: string;

  /** Path to prisma/migrations/ directory (auto-discovered via prisma.config.ts if omitted) */
  migrationsPath?: string;

  /** Pre-generated SQL to apply instead of auto-generating from schema */
  sql?: string;

  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

  /** Maximum pool connections (default: 5) */
  max?: number;
}

/** Clear all user tables. Call in `beforeEach` for per-test isolation. */
export type ResetDbFn = () => Promise<void>;

export interface PgliteAdapter {
  /** Prisma adapter — pass directly to `new PrismaClient({ adapter })` */
  adapter: PrismaPg;

  /** Clear all user tables. Call in `beforeEach` for per-test isolation. */
  resetDb: ResetDbFn;

  /** Shut down pool and PGlite. Not needed in tests (process exit handles it). */
  close: () => Promise<void>;
}

/**
 * Load Prisma config to discover schema path and migrations directory.
 * Uses the same resolution as `prisma migrate dev` — reads prisma.config.ts,
 * resolves paths relative to config file location.
 *
 * Returns null if @prisma/config is not available (older Prisma versions).
 */
const loadPrismaConfig = async (): Promise<{
  schemaPath: string | undefined;
  migrationsPath: string | undefined;
} | null> => {
  try {
    const { loadConfigFromFile } = await import('@prisma/config');
    const { config, error } = await loadConfigFromFile({ configRoot: process.cwd() });
    if (error) return null;

    const schemaPath = config.schema ?? undefined;

    // config.migrations?.path is set when prisma.config.ts specifies it.
    // Fallback: Prisma convention is {schemaDir}/migrations
    const migrationsPath =
      config.migrations?.path ?? (schemaPath ? join(dirname(schemaPath), 'migrations') : undefined);

    return { schemaPath, migrationsPath };
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
 * Generate SQL from schema.prisma using `prisma migrate diff`.
 * Spawns the Prisma CLI — ~1.9s. Used only as fallback when no migration
 * files exist.
 */
const generateSchemaSQL = (schemaPath: string): string =>
  execSync(`npx prisma migrate diff --from-empty --to-schema ${schemaPath} --script`, {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DATABASE_URL: 'postgresql://dummy@localhost/dummy' },
  });

/**
 * Resolve schema SQL. Priority:
 *   1. Explicit `sql` option — use directly
 *   2. Explicit `migrationsPath` — read migration files
 *   3. Auto-discovered migrations (via prisma.config.ts) — read migration files (~0ms)
 *   4. Auto-discovered schema (via prisma.config.ts) — `prisma migrate diff` (~1.9s fallback)
 *   5. Conventional paths (prisma/schema.prisma) — `prisma migrate diff` (~1.9s fallback)
 */
const resolveSQL = async (options: CreatePgliteAdapterOptions): Promise<string> => {
  if (options.sql) return options.sql;

  // Explicit migrationsPath
  if (options.migrationsPath) {
    const sql = tryReadMigrationFiles(options.migrationsPath);
    if (sql) return sql;
    throw new Error(`No migration.sql files found in ${options.migrationsPath}`);
  }

  // Auto-discover via Prisma config
  const prismaConfig = await loadPrismaConfig();

  // Try migrations first (instant)
  if (prismaConfig?.migrationsPath) {
    const sql = tryReadMigrationFiles(prismaConfig.migrationsPath);
    if (sql) return sql;
  }

  // Fall back to prisma migrate diff (slow but works without migration files)
  const schemaPath = options.schemaPath ?? prismaConfig?.schemaPath ?? findSchemaPath();

  if (!schemaPath) {
    throw new Error(
      'Could not find schema.prisma. Pass schemaPath, migrationsPath, or sql explicitly.',
    );
  }

  return generateSchemaSQL(schemaPath);
};

/**
 * Legacy fallback: find schema.prisma by checking conventional paths from cwd.
 */
const findSchemaPath = (): string | undefined => {
  const candidates = ['prisma/schema.prisma', 'schema.prisma'];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
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
  const sql = await resolveSQL(options);
  const {
    pool,
    pglite,
    close: poolClose,
  } = await createPool({
    dataDir: options.dataDir,
    max: options.max,
  });

  await pglite.exec(sql);

  const adapter = new PrismaPg(pool);

  const resetDb = async () => {
    const { rows } = await pglite.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public'
       AND tablename NOT LIKE '_prisma%'`,
    );

    if (rows.length > 0) {
      const tables = rows.map((r) => `"${r.tablename}"`).join(', ');
      try {
        await pglite.exec('SET session_replication_role = replica');
        await pglite.exec(`TRUNCATE TABLE ${tables} CASCADE`);
      } finally {
        await pglite.exec('SET session_replication_role = DEFAULT');
      }
    }
  };

  return { adapter, resetDb, close: poolClose };
};
