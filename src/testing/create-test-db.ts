/**
 * Test helper — creates an in-process PGlite database with schema applied.
 *
 * Returns a pg.Pool backed by PGlite, ready for PrismaPg. No TCP, no Docker,
 * no worker threads — everything runs in the same process.
 *
 * ```typescript
 * import { createTestDb } from 'prisma-enlite/testing';
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from '@prisma/client';
 *
 * let ctx: Awaited<ReturnType<typeof createTestDb>>;
 * let prisma: PrismaClient;
 *
 * beforeAll(async () => {
 *   ctx = await createTestDb();
 *   const adapter = new PrismaPg(ctx.pool);
 *   prisma = new PrismaClient({ adapter });
 * });
 *
 * beforeEach(async () => { await ctx.truncate(); });
 * afterAll(async () => { await ctx.close(); });
 * ```
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type pg from 'pg';
import { createPool } from '../create-pool.ts';

export interface CreateTestDbOptions {
  /** Path to schema.prisma (auto-discovered if omitted) */
  schemaPath?: string;

  /** Path to prisma/migrations/ directory — replays migration files instead of using migrate diff */
  migrationsPath?: string;

  /** Pre-generated SQL to apply instead of auto-generating from schema */
  sql?: string;

  /** PGlite data directory. Omit for in-memory. */
  dataDir?: string;

  /** Maximum pool connections (default: 1 — see createPool docs for why) */
  max?: number;
}

export interface TestDb {
  /** pg.Pool backed by PGlite — pass to PrismaPg */
  pool: pg.Pool;

  /** The underlying PGlite instance */
  pglite: PGlite;

  /** Truncate all user tables (call in beforeEach) */
  truncate: () => Promise<void>;

  /** Shut down pool and PGlite */
  close: () => Promise<void>;
}

/**
 * Auto-discover schema.prisma by walking up from cwd.
 */
const findSchemaPath = (): string | undefined => {
  const candidates = ['prisma/schema.prisma', 'schema.prisma'];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
};

/**
 * Generate SQL from schema.prisma using `prisma migrate diff`.
 * Fully offline — no database connection needed.
 */
const generateSchemaSQL = (schemaPath: string): string =>
  execSync(`npx prisma migrate diff --from-empty --to-schema ${schemaPath} --script`, {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DATABASE_URL: 'postgresql://dummy@localhost/dummy' },
  });

/**
 * Read migration SQL files from prisma/migrations/ in directory order.
 */
const readMigrationFiles = (migrationsPath: string): string => {
  if (!existsSync(migrationsPath)) {
    throw new Error(`Migrations directory not found: ${migrationsPath}`);
  }

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

  if (sqlParts.length === 0) {
    throw new Error(`No migration.sql files found in ${migrationsPath}`);
  }

  return sqlParts.join('\n');
};

/**
 * Resolve the SQL to apply: explicit sql > migrations > migrate diff.
 */
const resolveSQL = (options: CreateTestDbOptions): string => {
  if (options.sql) return options.sql;

  if (options.migrationsPath) {
    return readMigrationFiles(options.migrationsPath);
  }

  const schemaPath = options.schemaPath ?? findSchemaPath();
  if (!schemaPath) {
    throw new Error(
      'Could not find schema.prisma. Pass schemaPath, migrationsPath, or sql explicitly.',
    );
  }

  return generateSchemaSQL(schemaPath);
};

/**
 * Creates an in-process PGlite test database.
 *
 * Applies the schema and returns a pg.Pool + lifecycle functions for test setup/teardown.
 */
export const createTestDb = async (options: CreateTestDbOptions = {}): Promise<TestDb> => {
  const sql = resolveSQL(options);
  const {
    pool,
    pglite,
    close: poolClose,
  } = await createPool({
    dataDir: options.dataDir,
    max: options.max,
  });

  // Apply schema directly via PGlite (no need for pg.Client roundtrip)
  await pglite.exec(sql);

  const truncate = async () => {
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

  return { pool, pglite, truncate, close: poolClose };
};
