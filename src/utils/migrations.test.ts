import { describe, expect, it } from 'vitest';
import { createTempDir, createTempFile, removeTempDir } from '../__tests__/file-system.ts';
import { getMigrationSQL, readMigrationFiles } from './migrations.ts';

describe('migrations utilities', () => {
  it('prefers explicit sql over filesystem resolution', async () => {
    await expect(getMigrationSQL({ sql: 'SELECT 1', migrationsPath: '/missing' })).resolves.toBe(
      'SELECT 1',
    );
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
});
