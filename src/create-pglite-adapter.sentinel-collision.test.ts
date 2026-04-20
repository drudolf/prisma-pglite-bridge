import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createTestPgliteAdapter, withTempDataDir } from './__tests__/adapter.ts';
import { SENTINEL_MARKER, SENTINEL_SCHEMA, SENTINEL_TABLE } from './__tests__/sentinel.ts';

describe('sentinel initialization detection: collisions', () => {
  it('throws collision errors for reserved-schema, wrong-version, and wrong-column sentinel shapes on reopen and first-run sql', async () => {
    const cases = [
      {
        reopenSetupSql: `CREATE SCHEMA "${SENTINEL_SCHEMA}"`,
        reopenMessage: `Schema "${SENTINEL_SCHEMA}" exists but is not owned by prisma-pglite-bridge`,
        firstRunSql: null,
      },
      {
        reopenSetupSql: [
          `CREATE SCHEMA "${SENTINEL_SCHEMA}"`,
          `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
          `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 99)`,
        ].join(';\n'),
        reopenMessage: 'exists but is not owned by prisma-pglite-bridge',
        firstRunSql: [
          `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
          `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
          `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 99)`,
          'CREATE TABLE user_data (id int PRIMARY KEY)',
        ].join(';\n'),
      },
      {
        reopenSetupSql: [
          `CREATE SCHEMA "${SENTINEL_SCHEMA}"`,
          `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (id int PRIMARY KEY)`,
        ].join(';\n'),
        reopenMessage: 'exists but is not owned by prisma-pglite-bridge',
        firstRunSql: [
          `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
          `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (id int PRIMARY KEY)`,
          'CREATE TABLE user_data (id int PRIMARY KEY)',
        ].join(';\n'),
      },
    ] as const;

    for (const testCase of cases) {
      await withTempDataDir(async (dataDir) => {
        const raw = new PGlite(dataDir);
        await raw.exec(testCase.reopenSetupSql);
        await raw.close();

        await expect(createTestPgliteAdapter({ dataDir, sql: 'SELECT 1' })).rejects.toThrow(
          testCase.reopenMessage,
        );
      });

      if (testCase.firstRunSql) {
        await withTempDataDir(async (dataDir) => {
          await expect(
            createTestPgliteAdapter({ dataDir, sql: testCase.firstRunSql }),
          ).rejects.toThrow('exists but is not owned by prisma-pglite-bridge');
        });
      }
    }
  });

  it('throws collision error on first-run migration path when sentinel has wrong version', async () => {
    await withTempDataDir(async (dataDir) => {
      const migrationsPath = mkdtempSync(join(tmpdir(), 'migrations-'));
      const migrationDir = join(migrationsPath, '0001_init');
      mkdirSync(migrationDir);
      writeFileSync(
        join(migrationDir, 'migration.sql'),
        [
          `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
          `CREATE TABLE IF NOT EXISTS "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
          `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 99)`,
          'CREATE TABLE user_data (id int PRIMARY KEY)',
        ].join(';\n'),
      );

      try {
        await expect(createTestPgliteAdapter({ dataDir, migrationsPath })).rejects.toThrow(
          'exists but is not owned by prisma-pglite-bridge',
        );

        const raw = new PGlite(dataDir);
        const { rows } = await raw.query<{ found: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'user_data') AS found`,
        );
        expect(rows[0]?.found).toBe(false);
        await raw.close();
      } finally {
        rmSync(migrationsPath, { recursive: true, force: true });
      }
    });
  });

  it('throws collision error when sentinel table has extra non-library rows on first-run sql and reopen', async () => {
    const sql = [
      `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
      `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('user-owned', 99)`,
      'CREATE TABLE user_data (id int PRIMARY KEY)',
    ].join(';\n');

    await withTempDataDir(async (dataDir) => {
      await expect(createTestPgliteAdapter({ dataDir, sql })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );

      const raw = new PGlite(dataDir);
      const { rows } = await raw.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" WHERE marker = '${SENTINEL_MARKER}'`,
      );
      expect(rows[0]?.n).toBe(0);
      await raw.close();
    });

    await withTempDataDir(async (dataDir) => {
      const raw = new PGlite(dataDir);
      await raw.exec(`CREATE SCHEMA "${SENTINEL_SCHEMA}"`);
      await raw.exec(
        `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      );
      await raw.exec(
        `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 1)`,
      );
      await raw.exec(
        `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('user-owned', 99)`,
      );
      await raw.close();

      await expect(createTestPgliteAdapter({ dataDir, sql: 'SELECT 1' })).rejects.toThrow(
        'exists but is not owned by prisma-pglite-bridge',
      );
    });
  });
});
