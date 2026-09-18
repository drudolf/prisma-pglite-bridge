import { createHash } from 'node:crypto';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, createTempFile, removeTempDir } from '../__tests__/file-system.ts';
import { PgBridgeError } from '../errors.ts';
import { PGliteBridge } from '../pglite-bridge';
import {
  getMigrationSQL,
  hasMigrations,
  hasSchema,
  listMigrations,
  pushMigrations,
  readMigrationFiles,
} from './migrations.ts';

type MigrationsModule = typeof import('./migrations.ts');

const importMigrationsWithConfig = async (
  loadConfigFromFile: (args: { configRoot: string }) => Promise<unknown>,
): Promise<MigrationsModule> => {
  vi.resetModules();
  vi.doMock('@prisma/config', () => ({ loadConfigFromFile }));
  return import('./migrations.ts');
};

const importMigrationsWithBrokenConfig = async (): Promise<MigrationsModule> => {
  vi.resetModules();
  vi.doMock('@prisma/config', () => {
    throw new Error('broken import');
  });
  return import('./migrations.ts');
};

afterEach(() => {
  vi.doUnmock('@prisma/config');
  vi.resetModules();
});

describe('migrations utilities', () => {
  it('prefers explicit sql over filesystem resolution', async () => {
    await expect(getMigrationSQL({ sql: 'SELECT 1', migrationsPath: '/missing' })).resolves.toBe(
      'SELECT 1',
    );
  });

  it('returns undefined when the migrations directory does not exist', () => {
    expect(readMigrationFiles('/definitely/missing')).toBeUndefined();
  });

  it('reads migration files in directory order', () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      createTempFile(
        'migration.sql',
        'SELECT 2;',
        createTempDir('0002_second', migrationsPath).path,
      );
      createTempFile(
        'migration.sql',
        'SELECT 1;',
        createTempDir('0002_first', migrationsPath).path,
      );

      expect(readMigrationFiles(migrationsPath)).toBe('SELECT 1;\nSELECT 2;');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('skips migration directories that do not contain migration.sql', () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      createTempDir('0001_empty', migrationsPath);
      createTempFile(
        'migration.sql',
        'SELECT 2;',
        createTempDir('0002_second', migrationsPath).path,
      );

      expect(readMigrationFiles(migrationsPath)).toBe('SELECT 2;');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('returns SQL when an explicit migrations path contains migration files', async () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      createTempFile('migration.sql', 'SELECT 1;', createTempDir('0001_init', migrationsPath).path);

      await expect(getMigrationSQL({ migrationsPath })).resolves.toBe('SELECT 1;');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('throws an error when an explicit migrations path has no files', async () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      await expect(getMigrationSQL({ migrationsPath })).rejects.toThrow(
        `No migration.sql files found in ${migrationsPath}. Run \`prisma migrate dev\` to generate migration files.`,
      );
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('gets the migrations path from prisma config migrations.path', async () => {
    const loadConfigFromFile = vi.fn().mockResolvedValue({
      config: { migrations: { path: '/repo/prisma/migrations' } },
      error: undefined,
    });
    const { getMigrationsPath } = await importMigrationsWithConfig(loadConfigFromFile);

    await expect(getMigrationsPath('/repo')).resolves.toBe('/repo/prisma/migrations');
    expect(loadConfigFromFile).toHaveBeenCalledWith({ configRoot: '/repo' });
  });

  it('falls back to the schema directory when prisma config omits migrations.path', async () => {
    const { getMigrationsPath } = await importMigrationsWithConfig(
      vi.fn().mockResolvedValue({
        config: { schema: '/repo/prisma/schema.prisma' },
        error: undefined,
      }),
    );

    await expect(getMigrationsPath('/repo')).resolves.toBe('/repo/prisma/migrations');
  });

  it('returns undefined when prisma config loading reports an error', async () => {
    const { getMigrationsPath } = await importMigrationsWithConfig(
      vi.fn().mockResolvedValue({
        config: {},
        error: new Error('load failed'),
      }),
    );

    await expect(getMigrationsPath('/repo')).resolves.toBeUndefined();
  });

  it('returns undefined when @prisma/config cannot be imported', async () => {
    const { getMigrationsPath } = await importMigrationsWithBrokenConfig();

    await expect(getMigrationsPath('/repo')).resolves.toBeUndefined();
  });

  it('uses the auto-discovered migrations path from prisma config', async () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      createTempFile('migration.sql', 'SELECT 1;', createTempDir('0001_init', migrationsPath).path);

      const { getMigrationSQL: getMigrationSQLWithMock } = await importMigrationsWithConfig(
        vi.fn().mockResolvedValue({
          config: { migrations: { path: migrationsPath } },
          error: undefined,
        }),
      );

      await expect(getMigrationSQLWithMock({})).resolves.toBe('SELECT 1;');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('throws when the auto-discovered migrations path has no migration files', async () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      const { getMigrationSQL: getMigrationSQLWithMock } = await importMigrationsWithConfig(
        vi.fn().mockResolvedValue({
          config: { migrations: { path: migrationsPath } },
          error: undefined,
        }),
      );

      await expect(getMigrationSQLWithMock({})).rejects.toThrow(
        `No migration.sql files found in auto-discovered path ${migrationsPath}. Run \`prisma migrate dev\` to generate migration files, or pass pre-generated SQL via the \`sql\` option.`,
      );
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('throws a configRoot-specific error when prisma config resolves no schema or migrations', async () => {
    const { getMigrationSQL: getMigrationSQLWithMock } = await importMigrationsWithConfig(
      vi.fn().mockResolvedValue({
        config: {},
        error: undefined,
      }),
    );

    await expect(getMigrationSQLWithMock({ configRoot: '/repo' })).rejects.toThrow(
      'prisma.config.ts loaded from configRoot (/repo) but no schema or migrations path could be resolved. Ensure your config specifies a schema path, or pass pre-generated SQL via the `sql` option.',
    );
  });

  it('throws the final fallback error when no prisma config can be loaded', async () => {
    const { getMigrationSQL: getMigrationSQLWithMock } = await importMigrationsWithBrokenConfig();

    await expect(getMigrationSQLWithMock({})).rejects.toThrow(
      'No migration files found and no prisma.config.ts could be loaded. Run `prisma migrate dev` to generate them, or pass pre-generated SQL via the `sql` option.',
    );
  });
});

// One shared PGlite for the whole pushMigrations describe instead of a fresh
// ~1s cold boot per test. Top-level await is valid at module scope (ESM).
// Each test that needs a bridge creates its own PGliteBridge (caller-owned:
// bridge.close() leaves the shared pglite open). The beforeEach inside the
// describe wipes all user objects so each test starts from a truly empty schema.
const sharedPglite = new PGlite();
await sharedPglite.waitReady;

// Closed once at module teardown — several describes below share the instance.
afterAll(async () => {
  await sharedPglite.close();
});

// Drop public and any user-created schemas, then recreate public. This
// handles tables, types, sequences, functions, and schemas that individual
// tests create. Fail loud on errors — dirty state must not silently corrupt
// the next test's starting conditions.
const wipeSharedPglite = async (): Promise<void> => {
  const { rows } = await sharedPglite.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace
     WHERE nspname NOT IN ('pg_catalog', 'information_schema')
       AND nspname NOT LIKE 'pg_%'`,
  );
  for (const { nspname } of rows) {
    await sharedPglite.exec(`DROP SCHEMA IF EXISTS "${nspname}" CASCADE`);
  }
  await sharedPglite.exec('CREATE SCHEMA public');
  await sharedPglite.exec('GRANT ALL ON SCHEMA public TO public');
  await sharedPglite.exec('DISCARD ALL');
};

/** A migrations directory holding `<name>/migration.sql` for each entry, in the given order. */
const createMigrationsDir = (entries: Record<string, string>): string => {
  const { path: migrationsPath } = createTempDir('migrations');
  for (const [name, sql] of Object.entries(entries)) {
    createTempFile('migration.sql', sql, createTempDir(name, migrationsPath).path);
  }
  return migrationsPath;
};

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Prisma's own `_prisma_migrations` DDL — what `pushMigrations` and the engine both create. */
const PRISMA_MIGRATIONS_DDL = `CREATE TABLE IF NOT EXISTS _prisma_migrations (
  id                      VARCHAR(36) PRIMARY KEY NOT NULL,
  checksum                VARCHAR(64) NOT NULL,
  finished_at             TIMESTAMPTZ,
  migration_name          VARCHAR(255) NOT NULL,
  logs                    TEXT,
  rolled_back_at          TIMESTAMPTZ,
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_steps_count     INTEGER NOT NULL DEFAULT 0
)`;

interface HistoryRow {
  id: string;
  checksum: string;
  finished_at: string | null;
  migration_name: string;
  logs: string | null;
  rolled_back_at: string | null;
  applied_steps_count: number;
}

const readHistory = async (): Promise<HistoryRow[]> => {
  const { rows } = await sharedPglite.query<HistoryRow>(
    `SELECT id, checksum, finished_at::text, migration_name, logs, rolled_back_at::text,
            applied_steps_count
     FROM _prisma_migrations ORDER BY started_at, migration_name`,
  );
  return rows;
};

const catchError = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (e: unknown) => e,
  );

describe('pushMigrations', () => {
  beforeEach(wipeSharedPglite);

  // Bridges backed by the shared pglite — bridge.close() leaves sharedPglite open.
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn?.();
    }
  });

  const makeBridge = async () => {
    const bridge = new PGliteBridge({ pglite: sharedPglite });
    cleanups.push(async () => {
      await bridge.close();
    });
    return { pglite: sharedPglite, bridge };
  };

  it('applies inline SQL and returns durationMs', async () => {
    const { pglite: db } = await makeBridge();
    const result = await pushMigrations(db, {
      sql: 'CREATE TABLE "Demo" ("id" TEXT PRIMARY KEY);',
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const { rows } = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name = 'Demo'`,
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('applies SQL from a migrationsPath', async () => {
    const { path: migrationsPath } = createTempDir('migrations');
    try {
      createTempFile(
        'migration.sql',
        'CREATE TABLE "FromPath" ("id" TEXT PRIMARY KEY);',
        createTempDir('0001_init', migrationsPath).path,
      );

      const { pglite: db } = await makeBridge();
      await pushMigrations(db, { migrationsPath });

      const { rows } = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name = 'FromPath'`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('wraps PGlite exec failures with a descriptive error (in-memory)', async () => {
    const { pglite: db } = await makeBridge();
    await expect(pushMigrations(db, { sql: 'NOT VALID SQL' })).rejects.toThrow(
      'Failed to apply schema SQL to in-memory PGlite. Check your schema or migration files.',
    );
  });

  it('includes the dataDir path in failures for persistent instances', async () => {
    // Uses its own PGlite with a dataDir — the error message embeds the path,
    // so this test cannot use the shared in-memory instance.
    const { parent, path: dataDir } = createTempDir('persist');
    const dataDirPglite = new PGlite(dataDir);
    await dataDirPglite.waitReady;
    const dataDirBridge = new PGliteBridge({ pglite: dataDirPglite });
    try {
      await expect(pushMigrations(dataDirPglite, { sql: 'NOT VALID SQL' })).rejects.toThrow(
        `Failed to apply schema SQL to PGlite(dataDir=${dataDir}). Check your schema or migration files.`,
      );
    } finally {
      await dataDirBridge.close();
      await dataDirPglite.close();
      removeTempDir(parent);
    }
  });

  it('preserves the PGlite cause when a multi-statement migration fails partway', async () => {
    const { pglite: db } = await makeBridge();
    const sql = [
      'CREATE TABLE "Ok" ("id" TEXT PRIMARY KEY);',
      'CREATE TABLE "Broken" ("id" TEXT REFERENCES "Missing"("id"));',
      'CREATE TABLE "Unreached" ("id" TEXT PRIMARY KEY);',
    ].join('\n');

    const error = await pushMigrations(db, { sql }).then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /^Failed to apply schema SQL to in-memory PGlite\. Check your schema or migration files\./,
    );
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(String((cause as Error).message).toLowerCase()).toContain('missing');
  });

  it('hasMigrations returns false when _prisma_migrations table is absent', async () => {
    await expect(hasMigrations(sharedPglite)).resolves.toBe(false);
  });

  it('hasMigrations returns false when _prisma_migrations exists but no rows are finished', async () => {
    await sharedPglite.exec(`
      CREATE TABLE _prisma_migrations (
        id text PRIMARY KEY,
        checksum text NOT NULL,
        finished_at timestamptz,
        migration_name text NOT NULL,
        logs text,
        rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(),
        applied_steps_count int NOT NULL DEFAULT 0
      );
      INSERT INTO _prisma_migrations (id, checksum, migration_name)
      VALUES ('p', 'c', '0001_pending');
    `);
    await expect(hasMigrations(sharedPglite)).resolves.toBe(false);
  });

  it('hasMigrations returns true when _prisma_migrations has at least one finished row', async () => {
    await sharedPglite.exec(`
      CREATE TABLE _prisma_migrations (
        id text PRIMARY KEY,
        checksum text NOT NULL,
        finished_at timestamptz,
        migration_name text NOT NULL,
        logs text,
        rolled_back_at timestamptz,
        started_at timestamptz NOT NULL DEFAULT now(),
        applied_steps_count int NOT NULL DEFAULT 0
      );
      INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at)
      VALUES ('a', 'c', '0001_init', now());
    `);
    await expect(hasMigrations(sharedPglite)).resolves.toBe(true);
  });

  it('hasMigrations returns false when the finished-count query returns no rows', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ exists: true }] })
      .mockResolvedValueOnce({ rows: [] });
    const mockPglite = { query } as unknown as PGlite;

    await expect(hasMigrations(mockPglite)).resolves.toBe(false);
  });

  it('hasSchema returns false on an empty database', async () => {
    await expect(hasSchema(sharedPglite)).resolves.toBe(false);
  });

  it('hasSchema returns true when public has at least one user table', async () => {
    await sharedPglite.exec('CREATE TABLE "User" (id text PRIMARY KEY)');
    await expect(hasSchema(sharedPglite)).resolves.toBe(true);
  });

  it('hasSchema ignores tables outside the public schema', async () => {
    await sharedPglite.exec(`
      CREATE SCHEMA other;
      CREATE TABLE other.t (id int PRIMARY KEY);
    `);
    await expect(hasSchema(sharedPglite)).resolves.toBe(false);
  });
});

// ————— Tier A site pins: schema/migrations.ts —————

// Sites :96 and :106 — MIGRATIONS_UNAVAILABLE (two of the four)
describe('getMigrationSQL Tier A site pins — MIGRATIONS_UNAVAILABLE', () => {
  // Site :96 — explicit migrationsPath that exists but has no migration files
  it('rejects with PgBridgeError (code MIGRATIONS_UNAVAILABLE) when explicit path has no files', async () => {
    const { path: migrationsPath } = createTempDir('tier-a-pin-empty');
    try {
      const caught = await getMigrationSQL({ migrationsPath }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(caught).toBeInstanceOf(PgBridgeError);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as PgBridgeError).code).toBe('MIGRATIONS_UNAVAILABLE');
      expect((caught as PgBridgeError).name).toBe('PgBridgeError');
      expect(
        (caught as PgBridgeError).message.startsWith(
          `No migration.sql files found in ${migrationsPath}. Run \`prisma migrate dev\` to generate migration files.`,
        ),
      ).toBe(true);
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  // Site :121 — no configRoot supplied and no prisma config available
  it('rejects with PgBridgeError (code MIGRATIONS_UNAVAILABLE) for the final fallback (no config, no path)', async () => {
    // Reuses the established importMigrationsWithBrokenConfig helper so that
    // prisma/config cannot be imported, forcing the final throw site (:121).
    const { getMigrationSQL: getMigrationSQLBroken } = await importMigrationsWithBrokenConfig();

    const caught = await getMigrationSQLBroken({}).then(
      () => undefined,
      (e: unknown) => e,
    );

    // importMigrationsWithBrokenConfig loads a fresh module graph, so its
    // PgBridgeError is a different class object — instanceof against this
    // file's import cannot hold. Pin the contract shape instead; instanceof
    // Error still holds (same-realm Error base).
    expect(caught).toBeInstanceOf(Error);
    expect((caught as PgBridgeError).constructor.name).toBe('PgBridgeError');
    expect((caught as PgBridgeError).code).toBe('MIGRATIONS_UNAVAILABLE');
    expect((caught as PgBridgeError).name).toBe('PgBridgeError');
    expect((caught as PgBridgeError).message).toMatch(
      /^No migration files found and no prisma\.config\.ts could be loaded\. Run `prisma migrate dev` to generate them, or pass pre-generated SQL via the `sql` option\./,
    );
  });
});

// Site :148 — MIGRATIONS_APPLY_FAILED (preserves { cause })
describe('pushMigrations Tier A site pin — MIGRATIONS_APPLY_FAILED', () => {
  it('rejects with PgBridgeError (code MIGRATIONS_APPLY_FAILED) with cause populated on exec failure', async () => {
    // Uses sharedPglite (already warm) — invalid SQL triggers the catch block
    // at migrations.ts:148 that wraps the PGlite exec error and re-throws.
    const caught = await pushMigrations(sharedPglite, { sql: 'NOT VALID SQL' }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(PgBridgeError);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as PgBridgeError).code).toBe('MIGRATIONS_APPLY_FAILED');
    expect((caught as PgBridgeError).name).toBe('PgBridgeError');
    expect((caught as PgBridgeError).message).toMatch(
      /^Failed to apply schema SQL to in-memory PGlite\. Check your schema or migration files\./,
    );
    // { cause } must be populated (the PGlite exec error)
    expect((caught as PgBridgeError).cause).toBeInstanceOf(Error);
  });
});

// ————— Mutation-kill pins: schema/migrations.ts —————

// getMigrationsPath branch mutants (:48 error-guard, :53 schemaPath-guard).
// These use the fresh-module-graph config mock so loadConfigFromFile is fully
// controllable; the return value of getMigrationsPath is the observable.
describe('getMigrationsPath mutation-kill pins', () => {
  // :48 — `if (error) return undefined` -> `if (false) ...`. With a truthy
  // error AND a config that would otherwise resolve a path, the clean guard
  // short-circuits to undefined while the mutant proceeds and returns the path.
  it('returns undefined when config load reports an error even if a migrations path is present', async () => {
    const { getMigrationsPath } = await importMigrationsWithConfig(
      vi.fn().mockResolvedValue({
        config: { migrations: { path: '/repo/prisma/migrations' } },
        error: new Error('load failed'),
      }),
    );

    await expect(getMigrationsPath('/repo')).resolves.toBeUndefined();
  });

  // :53 — `if (schemaPath) return join(...)` -> `if (true) return join(...)`.
  // With a falsy-but-present schema ('' — no throw from dirname('')), the clean
  // guard skips and returns undefined; the mutant takes the branch and returns
  // join(dirname(''), 'migrations') === 'migrations'.
  it('returns undefined when the resolved schema path is an empty string', async () => {
    const { getMigrationsPath } = await importMigrationsWithConfig(
      vi.fn().mockResolvedValue({
        config: { schema: '' },
        error: undefined,
      }),
    );

    await expect(getMigrationsPath('/repo')).resolves.toBeUndefined();
  });
});

describe('readMigrationFiles mutation-kill pins', () => {
  // :69 filter-drop — `.filter(isDirectory)` removed. The filter's presence is
  // observable via a broken symlink at the migrations root: with the filter,
  // statSync(brokenlink) throws (ENOENT) inside the callback and the read fails;
  // without the filter, the non-directory entry is never stat'd, its
  // `<entry>/migration.sql` does not exist, and the real migration still reads,
  // so the mutant returns SQL instead of throwing.
  it('throws (does not silently skip) when a non-directory entry cannot be stat-ed', () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      createTempFile('migration.sql', 'SELECT 1;', createTempDir('0001_init', migrationsPath).path);
      // Dangling symlink — a non-directory entry whose statSync throws ENOENT.
      symlinkSync(join(migrationsPath, 'nonexistent-target'), join(migrationsPath, 'zz_broken'));

      expect(() => readMigrationFiles(migrationsPath)).toThrow();
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  // :81 ConditionalExpression (`... ? ... : undefined` -> `true ? ...`) and
  // :81 EqualityOperator (`length > 0` -> `length >= 0`) both make an EMPTY
  // sqlParts return '' (the join of no parts) instead of undefined. A directory
  // that exists but has no migration.sql anywhere must yield undefined, not ''.
  it('returns undefined (not an empty string) when an existing dir has no migration.sql', () => {
    const { path: migrationsPath } = createTempDir('migrations');

    try {
      createTempDir('0001_no_sql', migrationsPath);

      const result = readMigrationFiles(migrationsPath);
      expect(result).toBeUndefined();
      expect(result).not.toBe('');
    } finally {
      removeTempDir(migrationsPath);
    }
  });
});

// :109 (auto-discovered path) and :118 (configRoot resolves nothing):
// `'MIGRATIONS_UNAVAILABLE'` -> `''`. Pin the thrown error's `.code`.
describe('getMigrationSQL MIGRATIONS_UNAVAILABLE code pins', () => {
  // :109 — auto-discovered migrations path exists but has no migration files.
  it('throws with code MIGRATIONS_UNAVAILABLE for an empty auto-discovered path', async () => {
    const { path: migrationsPath } = createTempDir('auto-empty');
    try {
      const { getMigrationSQL: getMigrationSQLWithMock } = await importMigrationsWithConfig(
        vi.fn().mockResolvedValue({
          config: { migrations: { path: migrationsPath } },
          error: undefined,
        }),
      );

      const caught = await getMigrationSQLWithMock({}).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(caught).toBeInstanceOf(Error);
      expect((caught as PgBridgeError).code).toBe('MIGRATIONS_UNAVAILABLE');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  // :118 — config loads under configRoot but resolves no schema or path.
  it('throws with code MIGRATIONS_UNAVAILABLE for a configRoot that resolves nothing', async () => {
    const { getMigrationSQL: getMigrationSQLWithMock } = await importMigrationsWithConfig(
      vi.fn().mockResolvedValue({
        config: {},
        error: undefined,
      }),
    );

    const caught = await getMigrationSQLWithMock({ configRoot: '/repo' }).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(caught).toBeInstanceOf(Error);
    expect((caught as PgBridgeError).code).toBe('MIGRATIONS_UNAVAILABLE');
  });
});

// :164 durationMs arithmetic: `(end - start) / 1e6` — the `-`->`+` and `/`->`*`
// mutants both produce values in the billions of ms (raw hrtime nanoseconds are
// ~1e15+, and elapsed * 1e6 blows up too), whereas a real trivial exec is a
// small fraction of a millisecond. An upper bound far below the mutant floor
// (~6.7e9) yet far above any real timing kills both.
describe('pushMigrations durationMs mutation-kill pin', () => {
  it('reports a plausible (bounded) durationMs, not a raw-hrtime blowup', async () => {
    const timingPglite = new PGlite();
    await timingPglite.waitReady;
    const timingBridge = new PGliteBridge({ pglite: timingPglite });
    try {
      const result = await pushMigrations(timingPglite, {
        sql: 'CREATE TABLE "TimingProbe" ("id" TEXT PRIMARY KEY);',
      });

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      // Clean elapsed is sub-millisecond; both arithmetic mutants land in the
      // billions. 1e6 ms (~16 min) is an impossible real duration yet far under
      // the mutant floor.
      expect(result.durationMs).toBeLessThan(1e6);
    } finally {
      await timingBridge.close();
      await timingPglite.close();
    }
  });
});

// ————— listMigrations: the CLI's own listing (name / sql / checksum, localeCompare) —————

describe('listMigrations', () => {
  it('returns name, raw sql and the sha256 hex checksum of the bytes as read', () => {
    const lf = 'CREATE TABLE "A" ("id" TEXT PRIMARY KEY);\n';
    const crlf = 'CREATE TABLE "B" ("id" TEXT PRIMARY KEY);\r\n';
    const migrationsPath = createMigrationsDir({ '0001_lf': lf, '0002_crlf': crlf });
    try {
      const migrations = listMigrations(migrationsPath);

      expect(migrations).toEqual([
        { name: '0001_lf', sql: lf, checksum: sha256(lf) },
        { name: '0002_crlf', sql: crlf, checksum: sha256(crlf) },
      ]);
      // A CRLF file hashes its CRLF bytes — no normalization on the way in.
      expect(migrations[1]?.checksum).not.toBe(sha256(crlf.replaceAll('\r\n', '\n')));
      expect(migrations[1]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('orders entries with localeCompare (the Prisma CLI comparator), not code-point order', () => {
    const migrationsPath = createMigrationsDir({
      '20240101_B': 'SELECT 2;',
      '20240101_ä': 'SELECT 3;',
      '20240101_a': 'SELECT 1;',
    });
    try {
      const names = listMigrations(migrationsPath).map((m) => m.name);
      const fixture = ['20240101_a', '20240101_B', '20240101_ä'];

      expect(names).toEqual([...fixture].sort((a, b) => a.localeCompare(b)));
      // Code-point order puts 'B' (0x42) before 'a' (0x61); locale order does not.
      // A regression to plain `.sort()` would satisfy the line below, so pin the
      // two orders apart explicitly.
      expect([...fixture].sort()).toEqual(['20240101_B', '20240101_a', '20240101_ä']);
      expect(names).not.toEqual([...fixture].sort());
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('ignores non-directory entries and directories without migration.sql', () => {
    const migrationsPath = createMigrationsDir({ '0002_real': 'SELECT 1;' });
    try {
      createTempFile('migration_lock.toml', 'provider = "postgresql"\n', migrationsPath);
      createTempFile('.DS_Store', '', migrationsPath);
      createTempDir('0001_no_sql', migrationsPath);

      expect(listMigrations(migrationsPath).map((m) => m.name)).toEqual(['0002_real']);
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('returns an empty list when the directory does not exist', () => {
    expect(listMigrations('/definitely/missing/migrations')).toEqual([]);
  });
});

// ————— pushMigrations: `_prisma_migrations` bookkeeping on the migrationsPath path —————

const INIT_SQL = 'CREATE TABLE "Widget" ("id" TEXT PRIMARY KEY);\n';
const ADD_COLOR_SQL = 'ALTER TABLE "Widget" ADD COLUMN "color" TEXT NOT NULL DEFAULT \'red\';\n';

describe('pushMigrations history bookkeeping', () => {
  beforeEach(wipeSharedPglite);

  let migrationsPath: string;
  beforeEach(() => {
    migrationsPath = createMigrationsDir({
      '20240101000000_init': INIT_SQL,
      '20240101000001_add_color': ADD_COLOR_SQL,
    });
  });
  afterEach(() => {
    removeTempDir(migrationsPath);
  });

  it('records one finished row per applied migration with Prisma-shaped values', async () => {
    const result = await pushMigrations(sharedPglite, { migrationsPath });

    expect(result.applied).toEqual(['20240101000000_init', '20240101000001_add_color']);
    expect(result.skipped).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const rows = await readHistory();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.migration_name)).toEqual([
      '20240101000000_init',
      '20240101000001_add_color',
    ]);
    expect(rows.map((r) => r.checksum)).toEqual([sha256(INIT_SQL), sha256(ADD_COLOR_SQL)]);
    for (const row of rows) {
      expect(row.id).toHaveLength(36);
      expect(row.finished_at).not.toBeNull();
      expect(row.applied_steps_count).toBe(1);
      expect(row.logs).toBeNull();
      expect(row.rolled_back_at).toBeNull();
    }
  });

  it('is idempotent: the second call applies nothing and skips every recorded migration', async () => {
    await pushMigrations(sharedPglite, { migrationsPath });
    const second = await pushMigrations(sharedPglite, { migrationsPath });

    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['20240101000000_init', '20240101000001_add_color']);
    expect(await readHistory()).toHaveLength(2);

    const { rows } = await sharedPglite.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Widget' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['color', 'id']);
  });

  it('flips hasMigrations and hasSchema to true once migrations are applied', async () => {
    await expect(hasMigrations(sharedPglite)).resolves.toBe(false);
    await expect(hasSchema(sharedPglite)).resolves.toBe(false);

    await pushMigrations(sharedPglite, { migrationsPath });

    await expect(hasMigrations(sharedPglite)).resolves.toBe(true);
    await expect(hasSchema(sharedPglite)).resolves.toBe(true);
  });

  it('hasSchema stays false when only the _prisma_migrations table exists', async () => {
    await sharedPglite.exec(PRISMA_MIGRATIONS_DDL);
    await expect(hasSchema(sharedPglite)).resolves.toBe(false);
  });

  it('applies a migration added to the directory later, skipping the recorded ones', async () => {
    await pushMigrations(sharedPglite, { migrationsPath });
    createTempFile(
      'migration.sql',
      'CREATE TABLE "Gadget" ("id" TEXT PRIMARY KEY);\n',
      createTempDir('20240101000002_gadget', migrationsPath).path,
    );

    const result = await pushMigrations(sharedPglite, { migrationsPath });

    expect(result.applied).toEqual(['20240101000002_gadget']);
    expect(result.skipped).toEqual(['20240101000000_init', '20240101000001_add_color']);
    expect((await readHistory()).map((r) => r.migration_name)).toEqual([
      '20240101000000_init',
      '20240101000001_add_color',
      '20240101000002_gadget',
    ]);
  });

  it('creates _prisma_migrations unqualified, so it lands in the session search_path schema', async () => {
    await sharedPglite.exec('CREATE SCHEMA other');
    await sharedPglite.exec('SET search_path TO other');
    try {
      await pushMigrations(sharedPglite, { migrationsPath });

      const { rows } = await sharedPglite.query<{ other: boolean; pub: boolean }>(
        `SELECT to_regclass('other._prisma_migrations') IS NOT NULL AS other,
                to_regclass('public._prisma_migrations') IS NOT NULL AS pub`,
      );
      expect(rows[0]).toEqual({ other: true, pub: false });
    } finally {
      await sharedPglite.exec('RESET search_path');
    }
  });
});

// ————— pushMigrations: history validation (MIGRATIONS_HISTORY_INVALID) —————

describe('pushMigrations history validation', () => {
  beforeEach(wipeSharedPglite);

  let migrationsPath: string;
  beforeEach(async () => {
    migrationsPath = createMigrationsDir({ '20240101000000_init': INIT_SQL });
    await pushMigrations(sharedPglite, { migrationsPath });
  });
  afterEach(() => {
    removeTempDir(migrationsPath);
  });

  const expectHistoryInvalid = async (pattern: RegExp): Promise<void> => {
    const caught = await catchError(pushMigrations(sharedPglite, { migrationsPath }));
    expect(caught).toBeInstanceOf(PgBridgeError);
    expect((caught as PgBridgeError).code).toBe('MIGRATIONS_HISTORY_INVALID');
    expect((caught as PgBridgeError).message).toMatch(pattern);
  };

  it('rejects a started-but-unfinished row and points at both migrate resolve forms', async () => {
    await sharedPglite.query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ('f', $1, '20240101000001_half')`,
      [sha256('x')],
    );
    await expectHistoryInvalid(
      /20240101000001_half started but never finished.*migrate resolve --applied.*--rolled-back/s,
    );
  });

  it('rejects two active rows for one migration name', async () => {
    await sharedPglite.query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count)
       VALUES ('dup', $1, '20240101000000_init', now(), 1)`,
      [sha256(INIT_SQL)],
    );
    await expectHistoryInvalid(/20240101000000_init has more than one active history row/);
  });

  it('rejects an active row whose migration directory is missing, naming the migrationsPath', async () => {
    await sharedPglite.query(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, applied_steps_count)
       VALUES ('ghost', $1, '20240101000001_ghost', now(), 1)`,
      [sha256('x')],
    );
    const caught = await catchError(pushMigrations(sharedPglite, { migrationsPath }));
    expect((caught as PgBridgeError).code).toBe('MIGRATIONS_HISTORY_INVALID');
    expect((caught as PgBridgeError).message).toContain(
      `20240101000001_ghost is applied in the database but missing from ${migrationsPath}`,
    );
  });

  it('rejects a migration.sql edited after it was applied', async () => {
    writeFileSync(
      join(migrationsPath, '20240101000000_init', 'migration.sql'),
      `${INIT_SQL}-- edited\n`,
    );
    await expectHistoryInvalid(/20240101000000_init was modified after it was applied/);
  });

  it('tolerates a line-ending change: LF stored, CRLF on disk', async () => {
    writeFileSync(
      join(migrationsPath, '20240101000000_init', 'migration.sql'),
      INIT_SQL.replaceAll('\n', '\r\n'),
    );
    const result = await pushMigrations(sharedPglite, { migrationsPath });
    expect(result).toMatchObject({ applied: [], skipped: ['20240101000000_init'] });
  });

  it('tolerates a line-ending change: CRLF stored, LF on disk', async () => {
    const crlfSql = 'CREATE TABLE "Crlf" ("id" TEXT PRIMARY KEY);\r\n';
    createTempFile(
      'migration.sql',
      crlfSql,
      createTempDir('20240101000005_crlf', migrationsPath).path,
    );
    await pushMigrations(sharedPglite, { migrationsPath });
    expect((await readHistory()).map((r) => r.checksum)).toContain(sha256(crlfSql));

    writeFileSync(
      join(migrationsPath, '20240101000005_crlf', 'migration.sql'),
      crlfSql.replaceAll('\r\n', '\n'),
    );
    const result = await pushMigrations(sharedPglite, { migrationsPath });
    expect(result).toMatchObject({
      applied: [],
      skipped: ['20240101000000_init', '20240101000005_crlf'],
    });
  });

  it('re-applies a rolled-back migration and keeps the rolled-back row', async () => {
    await sharedPglite.exec('UPDATE _prisma_migrations SET rolled_back_at = now()');
    await sharedPglite.exec('DROP TABLE "Widget"');

    const result = await pushMigrations(sharedPglite, { migrationsPath });

    expect(result.applied).toEqual(['20240101000000_init']);
    expect(result.skipped).toEqual([]);
    const rows = await readHistory();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.rolled_back_at === null)).toHaveLength(1);
    await expect(hasSchema(sharedPglite)).resolves.toBe(true);
  });
});

// ————— pushMigrations: failure model (MIGRATIONS_APPLY_FAILED keeps the started row) —————

describe('pushMigrations apply failure on the migrationsPath path', () => {
  beforeEach(wipeSharedPglite);

  it('throws MIGRATIONS_APPLY_FAILED naming the migration, keeps its started row, and reports it next time', async () => {
    const migrationsPath = createMigrationsDir({
      '20240101000000_init': INIT_SQL,
      '20240101000001_broken': 'CREATE TABLE "Broken" ("id" TEXT REFERENCES "Missing"("id"));\n',
      '20240101000002_unreached': 'CREATE TABLE "Unreached" ("id" TEXT PRIMARY KEY);\n',
    });
    try {
      const caught = await catchError(pushMigrations(sharedPglite, { migrationsPath }));

      expect(caught).toBeInstanceOf(PgBridgeError);
      expect((caught as PgBridgeError).code).toBe('MIGRATIONS_APPLY_FAILED');
      expect((caught as PgBridgeError).message).toMatch(
        /^Failed to apply migration 20240101000001_broken to in-memory PGlite\./,
      );
      const cause = (caught as PgBridgeError).cause;
      expect(cause).toBeInstanceOf(Error);
      expect((cause as Error).message.toLowerCase()).toContain('missing');

      const rows = await readHistory();
      expect(rows.map((r) => [r.migration_name, r.finished_at === null])).toEqual([
        ['20240101000000_init', false],
        ['20240101000001_broken', true],
      ]);

      const again = await catchError(pushMigrations(sharedPglite, { migrationsPath }));
      expect((again as PgBridgeError).code).toBe('MIGRATIONS_HISTORY_INVALID');
      expect((again as PgBridgeError).message).toMatch(
        /20240101000001_broken started but never finished.*migrate resolve --applied/s,
      );
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('names the dataDir in the failure message for persistent instances', async () => {
    const { parent, path: dataDir } = createTempDir('persist-mig');
    const migrationsPath = createMigrationsDir({ '20240101000000_bad': 'NOT VALID SQL' });
    const dataDirPglite = new PGlite(dataDir);
    try {
      await dataDirPglite.waitReady;
      const caught = await catchError(pushMigrations(dataDirPglite, { migrationsPath }));
      expect((caught as PgBridgeError).code).toBe('MIGRATIONS_APPLY_FAILED');
      expect((caught as PgBridgeError).message).toContain(
        `Failed to apply migration 20240101000000_bad to PGlite(dataDir=${dataDir}).`,
      );
    } finally {
      await dataDirPglite.close();
      removeTempDir(migrationsPath);
      removeTempDir(parent);
    }
  });
});

describe('pushMigrations baseline check (schema not empty, no history)', () => {
  beforeEach(wipeSharedPglite);

  it('refuses to apply over existing tables without history and names the baseline repair', async () => {
    await sharedPglite.exec('CREATE TABLE "Legacy" ("id" TEXT PRIMARY KEY)');
    const migrationsPath = createMigrationsDir({
      '0001_init': 'CREATE TABLE "Legacy" ("id" TEXT PRIMARY KEY);',
    });
    try {
      const error = await catchError(pushMigrations(sharedPglite, { migrationsPath }));
      expect(error).toBeInstanceOf(PgBridgeError);
      expect((error as PgBridgeError).code).toBe('MIGRATIONS_HISTORY_INVALID');
      expect((error as Error).message).toContain('schema is not empty');
      expect((error as Error).message).toContain('migrate resolve --applied');
      // Refused before any apply: no started row was written.
      const { rows } = await sharedPglite.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM _prisma_migrations',
      );
      expect(rows[0]?.n).toBe(0);
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('sees tables in non-default schemas (multiSchema dataDirs)', async () => {
    await sharedPglite.exec(
      'CREATE SCHEMA audit; CREATE TABLE audit."Log" ("id" TEXT PRIMARY KEY)',
    );
    const migrationsPath = createMigrationsDir({ '0001_init': 'SELECT 1;' });
    try {
      const error = await catchError(pushMigrations(sharedPglite, { migrationsPath }));
      expect((error as PgBridgeError).code).toBe('MIGRATIONS_HISTORY_INVALID');
      expect((error as Error).message).toContain('schema is not empty');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('does not count the bridge snapshot schema as user tables', async () => {
    await sharedPglite.exec(
      'CREATE SCHEMA _pglite_snapshot; CREATE TABLE _pglite_snapshot.__tables (snap_name text)',
    );
    const migrationsPath = createMigrationsDir({ '0001_init': 'SELECT 1;' });
    try {
      const result = await pushMigrations(sharedPglite, { migrationsPath });
      expect(result.applied).toEqual(['0001_init']);
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('ignores rolled-back rows when deciding the history is empty', async () => {
    await sharedPglite.exec('CREATE TABLE "Legacy" ("id" TEXT PRIMARY KEY)');
    await sharedPglite.exec(PRISMA_MIGRATIONS_DDL);
    await sharedPglite.exec(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, finished_at, rolled_back_at)
       VALUES ('r', 'c', '0001_init', now(), now())`,
    );
    const migrationsPath = createMigrationsDir({ '0001_init': 'SELECT 1;' });
    try {
      const error = await catchError(pushMigrations(sharedPglite, { migrationsPath }));
      expect((error as PgBridgeError).code).toBe('MIGRATIONS_HISTORY_INVALID');
      expect((error as Error).message).toContain('schema is not empty');
    } finally {
      removeTempDir(migrationsPath);
    }
  });
});
