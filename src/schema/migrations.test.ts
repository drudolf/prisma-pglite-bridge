import { symlinkSync } from 'node:fs';
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

describe('pushMigrations', () => {
  afterAll(async () => {
    await sharedPglite.close();
  });

  // Drop public and any user-created schemas, then recreate public. This
  // handles tables, types, sequences, functions, and schemas that individual
  // tests create. Fail loud on errors — dirty state must not silently corrupt
  // the next test's starting conditions.
  beforeEach(async () => {
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
  });

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
    expect((error as Error).message).toBe(
      'Failed to apply schema SQL to in-memory PGlite. Check your schema or migration files.',
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
      expect((caught as PgBridgeError).message).toBe(
        `No migration.sql files found in ${migrationsPath}. Run \`prisma migrate dev\` to generate migration files.`,
      );
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
    expect((caught as PgBridgeError).message).toBe(
      'No migration files found and no prisma.config.ts could be loaded. Run `prisma migrate dev` to generate them, or pass pre-generated SQL via the `sql` option.',
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
    expect((caught as PgBridgeError).message).toBe(
      'Failed to apply schema SQL to in-memory PGlite. Check your schema or migration files.',
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
