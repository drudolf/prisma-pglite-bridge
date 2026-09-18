/**
 * Apply pre-generated SQL (raw or from `prisma/migrations/`) to a PGlite
 * database. Sibling of {@link pushSchema} — both populate a database, but
 * `pushMigrations` takes a `PGlite` directly and bypasses
 * `@prisma/schema-engine-wasm`. Use when you already have generated SQL
 * and don't need a live schema diff.
 *
 * On the `migrationsPath` path it keeps Prisma's own `_prisma_migrations`
 * history (same DDL, same checksum, same rows as `prisma migrate deploy`),
 * so the Prisma CLI sees the migrations as applied and a second call on a
 * persistent `dataDir` is a no-op.
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
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import { PgBridgeError } from '../errors.ts';

export interface PushMigrationsOptions {
  /** Pre-generated SQL to apply directly. Applied as one statement batch; no `_prisma_migrations` bookkeeping. */
  sql?: string;
  /** Path to a `prisma/migrations/` directory (auto-discovered via prisma.config.ts if omitted). */
  migrationsPath?: string;
  /** Root for prisma.config.ts discovery (default: process.cwd()). Set in monorepos where tests run from the workspace root. */
  configRoot?: string;
}

export interface PushMigrationsResult {
  /**
   * Wall-clock time of the apply, in milliseconds: the SQL itself on the
   * `sql` path; history validation, bookkeeping rows, and the scripts on the
   * migrations-directory path.
   */
  durationMs: number;
  /** Migration names applied by this call, in order. Empty on the `sql` path. */
  applied: string[];
  /** Migration names already recorded in `_prisma_migrations` and skipped. Empty on the `sql` path. */
  skipped: string[];
}

/** One `prisma/migrations/<name>/migration.sql`, as the Prisma CLI lists it. */
export interface MigrationFile {
  /** Directory name, e.g. `20240101120000_init` — Prisma's `migration_name`. */
  name: string;
  /** File text as read (`utf8`), no normalization — the bytes Prisma hashes. */
  sql: string;
  /** SHA-256 of `sql`, lowercase hex — the value Prisma stores in `checksum`. */
  checksum: string;
}

/**
 * The engine's own DDL (`sql-schema-connector/src/flavour/postgres.rs`),
 * unqualified exactly as Prisma creates it, so it lands in the session's
 * default schema. `IF NOT EXISTS`: an engine-created table is left as is.
 */
const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS _prisma_migrations (
  id                      VARCHAR(36) PRIMARY KEY NOT NULL,
  checksum                VARCHAR(64) NOT NULL,
  finished_at             TIMESTAMPTZ,
  migration_name          VARCHAR(255) NOT NULL,
  logs                    TEXT,
  rolled_back_at          TIMESTAMPTZ,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count     INTEGER NOT NULL DEFAULT 0
)`;

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

/** SHA-256 over the script text as read, lowercase hex — Prisma's `checksum`. */
export const migrationChecksum = (sql: string): string =>
  createHash('sha256').update(sql, 'utf8').digest('hex');

/**
 * List migrations the way `prisma migrate` does: every directory entry
 * (`isDirectory()`, no name pattern) that holds a `migration.sql`, ordered
 * with `localeCompare` — the CLI's own comparator (`listMigrations` in
 * `prisma/build/cli.js`). Returns `[]` when the directory is missing.
 */
export const listMigrations = (migrationsPath: string): MigrationFile[] => {
  if (!existsSync(migrationsPath)) return [];

  return readdirSync(migrationsPath)
    .filter((entry) => statSync(join(migrationsPath, entry)).isDirectory())
    .sort((a, b) => a.localeCompare(b))
    .flatMap((name) => {
      const sqlPath = join(migrationsPath, name, 'migration.sql');
      if (!existsSync(sqlPath)) return [];
      const sql = readFileSync(sqlPath, 'utf8');
      return [{ name, sql, checksum: migrationChecksum(sql) }];
    });
};

/**
 * Read and concatenate every `migration.sql` under a migrations directory in
 * directory order. Returns undefined if the directory doesn't exist or has no
 * migration files.
 */
export const readMigrationFiles = (migrationsPath: string): string | undefined => {
  const migrations = listMigrations(migrationsPath);
  return migrations.length > 0 ? migrations.map((m) => m.sql).join('\n') : undefined;
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
  const { migrations } = await resolveMigrations(options);
  return migrations.map((m) => m.sql).join('\n');
};

/** The migrations directory that {@link pushMigrations} would use, plus its files. */
const resolveMigrations = async (
  options: PushMigrationsOptions,
): Promise<{ migrationsPath: string; migrations: MigrationFile[] }> => {
  if (options.migrationsPath) {
    const migrations = listMigrations(options.migrationsPath);
    if (migrations.length > 0) return { migrationsPath: options.migrationsPath, migrations };
    throw new PgBridgeError(
      'MIGRATIONS_UNAVAILABLE',
      `No migration.sql files found in ${options.migrationsPath}. Run \`prisma migrate dev\` to generate migration files.`,
    );
  }

  const migrationsPath = await getMigrationsPath(options.configRoot);
  if (migrationsPath) {
    const migrations = listMigrations(migrationsPath);
    if (migrations.length > 0) return { migrationsPath, migrations };

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

const describeTarget = (pglite: PGlite | PGliteInterface): string =>
  pglite.dataDir ? `PGlite(dataDir=${pglite.dataDir})` : 'in-memory PGlite';

interface HistoryRow {
  migration_name: string;
  checksum: string;
  finished_at: string | null;
  rolled_back_at: string | null;
}

/** Prisma's compare: raw, then CRLF→LF, then LF→CRLF (`checksum.rs:12-41`). */
const checksumMatches = (stored: string, sql: string): boolean =>
  [sql, sql.replaceAll('\r\n', '\n'), sql.replace(/\r?\n/g, '\r\n')].some(
    (candidate) => migrationChecksum(candidate) === stored,
  );

/**
 * Any base table in any non-system schema other than Prisma's bookkeeping —
 * every schema, not just the default one, so a `multiSchema` dataDir with
 * tables only in a secondary schema is caught too. The snapshot schema is
 * bridge-internal and does not count.
 */
const hasUserTables = async (pglite: PGlite | PGliteInterface): Promise<boolean> => {
  const { rows } = await pglite.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
         AND table_schema NOT LIKE 'pg\\_%'
         AND table_schema NOT LIKE '\\_pglite\\_snapshot%'
         AND table_type = 'BASE TABLE'
         AND table_name NOT LIKE '\\_prisma%'
     ) AS exists`,
  );
  return rows[0]?.exists === true;
};

const historyInvalid = (detail: string): PgBridgeError =>
  new PgBridgeError(
    'MIGRATIONS_HISTORY_INVALID',
    `_prisma_migrations history is invalid: ${detail}`,
  );

/**
 * The diagnostics `migrate deploy` / `status` / `dev` run before applying,
 * in the order Prisma reports them: failed rows (P3009), duplicate active
 * rows, rows without a directory (`MigrationsDirectoryIsBehind`), and
 * modified scripts (`edited_migration_names`). Rolled-back rows are ignored
 * here and re-applied by the caller, as `migrate deploy` does.
 */
const validateHistory = (
  rows: HistoryRow[],
  migrations: MigrationFile[],
  migrationsPath: string,
): void => {
  const active = rows.filter((row) => row.rolled_back_at === null);
  const byName = new Map(migrations.map((m) => [m.name, m] as const));

  const failed = active.filter((row) => row.finished_at === null).map((row) => row.migration_name);
  if (failed.length > 0) {
    throw historyInvalid(
      `migration ${failed.join(', ')} started but never finished. If its SQL is present in the ` +
        'database run `prisma migrate resolve --applied <name>`; otherwise ' +
        '`prisma migrate resolve --rolled-back <name>` (safe only for a script that did not partially apply).',
    );
  }

  const seen = new Set<string>();
  for (const row of active) {
    if (seen.has(row.migration_name)) {
      throw historyInvalid(
        `migration ${row.migration_name} has more than one active history row; repair with ` +
          '`prisma migrate resolve` or delete the extra rows.',
      );
    }
    seen.add(row.migration_name);
  }

  const missing = active
    .filter((row) => !byName.has(row.migration_name))
    .map((row) => row.migration_name);
  if (missing.length > 0) {
    throw historyInvalid(
      `migration ${missing.join(', ')} is applied in the database but missing from ` +
        `${migrationsPath}. Restore the directory or reset the database.`,
    );
  }

  for (const row of active) {
    const file = byName.get(row.migration_name);
    if (file !== undefined && !checksumMatches(row.checksum, file.sql)) {
      throw historyInvalid(
        `migration ${row.migration_name} was modified after it was applied. Restore the original ` +
          'migration.sql, or create a new migration for the change.',
      );
    }
  }
};

/**
 * Apply pending migrations with `migrate deploy` bookkeeping: insert the
 * started row, run the script exactly as one `exec` (Prisma's granularity),
 * then mark it finished. A script failure leaves the started row in place —
 * Prisma's own failed-row model — so the next call reports it instead of
 * re-running the script.
 */
const applyMigrations = async (
  pglite: PGlite | PGliteInterface,
  migrationsPath: string,
  migrations: MigrationFile[],
): Promise<{ applied: string[]; skipped: string[] }> => {
  await pglite.exec(MIGRATIONS_TABLE_DDL);
  const { rows } = await pglite.query<HistoryRow>(
    'SELECT migration_name, checksum, finished_at::text, rolled_back_at::text FROM _prisma_migrations',
  );
  if (rows.every((row) => row.rolled_back_at !== null) && (await hasUserTables(pglite))) {
    // Prisma's P3005: tables exist but no migration history. Applying would
    // fail on the first CREATE TABLE and leave a started row behind, so refuse
    // up front with the baseline repair — the case for dataDirs populated by
    // pushMigrations before 1.9 (no bookkeeping), pushSchema, or raw SQL.
    throw historyInvalid(
      'the database schema is not empty but _prisma_migrations records no applied migration. ' +
        'Baseline it: run `prisma migrate resolve --applied <name>` for each migration (through ' +
        'a PGliteServer over this dataDir), or start from an empty dataDir.',
    );
  }
  validateHistory(rows, migrations, migrationsPath);

  const done = new Set(
    rows.filter((row) => row.rolled_back_at === null).map((row) => row.migration_name),
  );
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    if (done.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }
    const id = randomUUID();
    await pglite.query(
      'INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at) VALUES ($1, $2, $3, now())',
      [id, migration.checksum, migration.name],
    );
    try {
      await pglite.exec(migration.sql);
    } catch (err) {
      throw new PgBridgeError(
        'MIGRATIONS_APPLY_FAILED',
        `Failed to apply migration ${migration.name} to ${describeTarget(pglite)}. Check the ` +
          'migration file; its started history row was kept so the next run reports it.',
        { cause: err },
      );
    }
    await pglite.query(
      'UPDATE _prisma_migrations SET finished_at = now(), applied_steps_count = 1 WHERE id = $1',
      [id],
    );
    applied.push(migration.name);
  }
  return { applied, skipped };
};

/**
 * Apply pre-generated SQL to a PGlite instance.
 *
 * Runs the SQL through `pglite.exec(...)` directly, bypassing any bridge
 * pool. No schema engine, no WASM module, no diffing — useful when you
 * already have a `prisma/migrations` directory or pre-generated SQL.
 *
 * With `migrationsPath` (or auto-discovery) each migration is applied with
 * `prisma migrate deploy` bookkeeping in `_prisma_migrations`: already
 * applied migrations are skipped, so the call is idempotent on a persistent
 * `dataDir`, and the Prisma CLI (`migrate status` / `deploy` / `dev` through
 * `PGliteServer`) sees the history. Concurrent calls on one instance are
 * unsupported. With `sql` the text is applied as one batch with no
 * bookkeeping — not idempotent; guard with {@link hasSchema}.
 *
 * Pass the same PGlite instance you handed to {@link PGliteBridge}
 * (i.e. `bridge.pglite`) — or any standalone `PGlite` you own.
 *
 * @throws {PgBridgeError} `MIGRATIONS_UNAVAILABLE` when no usable
 *   migrations source resolves (no `sql`, no `migration.sql` files, no
 *   loadable `prisma.config.ts`); `MIGRATIONS_HISTORY_INVALID` when
 *   `_prisma_migrations` holds a failed, duplicate, orphaned, or modified
 *   migration; `MIGRATIONS_APPLY_FAILED` (with `cause`) when applying the
 *   SQL fails.
 */
export const pushMigrations = async (
  pglite: PGlite | PGliteInterface,
  options: PushMigrationsOptions = {},
): Promise<PushMigrationsResult> => {
  if (options.sql) {
    const start = process.hrtime.bigint();
    try {
      await pglite.exec(options.sql);
    } catch (err) {
      throw new PgBridgeError(
        'MIGRATIONS_APPLY_FAILED',
        `Failed to apply schema SQL to ${describeTarget(pglite)}. Check your schema or migration files.`,
        { cause: err },
      );
    }
    return { durationMs: elapsedMs(start), applied: [], skipped: [] };
  }

  const { migrationsPath, migrations } = await resolveMigrations(options);
  const start = process.hrtime.bigint();
  const { applied, skipped } = await applyMigrations(pglite, migrationsPath, migrations);
  return { durationMs: elapsedMs(start), applied, skipped };
};

const elapsedMs = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e6;

/**
 * Returns `true` when the `_prisma_migrations` table exists (in the
 * session's default schema, where both Prisma and {@link pushMigrations}
 * create it) and has at least one row with `finished_at IS NOT NULL` —
 * i.e. the Prisma CLI or `pushMigrations` has applied migrations to this
 * database. `pushSchema` (WASM diff) records nothing, so this stays `false`
 * after it; use {@link hasSchema} there.
 *
 * Awaits `pglite.waitReady` implicitly via `pglite.query(...)`.
 */
export const hasMigrations = async (pglite: PGlite | PGliteInterface): Promise<boolean> => {
  const { rows } = await pglite.query<{ exists: boolean }>(
    `SELECT to_regclass('_prisma_migrations') IS NOT NULL AS exists`,
  );
  if (!rows[0]?.exists) return false;

  const { rows: applied } = await pglite.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
  );
  return (applied[0]?.count ?? 0) > 0;
};

/**
 * Returns `true` when the `public` schema contains at least one user table
 * other than Prisma's own `_prisma_migrations` bookkeeping. Broader sibling
 * of {@link hasMigrations} — fires for any DDL, regardless of whether it
 * came from {@link pushMigrations}, {@link pushSchema}, or hand-rolled SQL.
 * The "first run" guard for `pushSchema` and the `sql` path of
 * `pushMigrations` on a persistent dataDir (the `migrationsPath` path is
 * idempotent and needs no guard):
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
         AND table_name NOT LIKE '\\_prisma%'
     ) AS exists`,
  );
  return rows[0]?.exists === true;
};
