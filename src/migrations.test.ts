import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTempDir, createTempFile, removeTempDir } from './__tests__/utils/file-system.ts';
import { getMigrationSQL, pushMigrations, readMigrationFiles } from './migrations.ts';
import { createPGliteBridge } from './pglite-bridge.ts';

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

describe('pushMigrations', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      await fn?.();
    }
  });

  const makeBridge = async (dataDir?: string) => {
    const pglite = new PGlite(dataDir);
    await pglite.waitReady;
    const bridge = await createPGliteBridge({ pglite });
    cleanups.push(async () => {
      await bridge.close();
      await pglite.close();
    });
    return { pglite, bridge };
  };

  it('applies inline SQL and returns durationMs', async () => {
    const { pglite } = await makeBridge();
    const result = await pushMigrations(pglite, {
      sql: 'CREATE TABLE "Demo" ("id" TEXT PRIMARY KEY);',
    });

    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const { rows } = await pglite.query<{ count: string }>(
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

      const { pglite } = await makeBridge();
      await pushMigrations(pglite, { migrationsPath });

      const { rows } = await pglite.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_name = 'FromPath'`,
      );
      expect(rows[0]?.count).toBe('1');
    } finally {
      removeTempDir(migrationsPath);
    }
  });

  it('wraps PGlite exec failures with a descriptive error (in-memory)', async () => {
    const { pglite } = await makeBridge();
    await expect(pushMigrations(pglite, { sql: 'NOT VALID SQL' })).rejects.toThrow(
      'Failed to apply schema SQL to in-memory PGlite. Check your schema or migration files.',
    );
  });

  it('includes the dataDir path in failures for persistent instances', async () => {
    const { parent, path: dataDir } = createTempDir('persist');
    cleanups.push(async () => {
      removeTempDir(parent);
    });
    const { pglite } = await makeBridge(dataDir);
    await expect(pushMigrations(pglite, { sql: 'NOT VALID SQL' })).rejects.toThrow(
      `Failed to apply schema SQL to PGlite(dataDir=${dataDir}). Check your schema or migration files.`,
    );
  });

  it('preserves the PGlite cause when a multi-statement migration fails partway', async () => {
    const { pglite } = await makeBridge();
    const sql = [
      'CREATE TABLE "Ok" ("id" TEXT PRIMARY KEY);',
      'CREATE TABLE "Broken" ("id" TEXT REFERENCES "Missing"("id"));',
      'CREATE TABLE "Unreached" ("id" TEXT PRIMARY KEY);',
    ].join('\n');

    const error = await pushMigrations(pglite, { sql }).then(
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
});
