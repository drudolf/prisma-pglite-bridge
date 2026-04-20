import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDir, createTempFile, removeTempDir } from '../__tests__/file-system.ts';
import { getMigrationSQL, readMigrationFiles } from './migrations.ts';

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
