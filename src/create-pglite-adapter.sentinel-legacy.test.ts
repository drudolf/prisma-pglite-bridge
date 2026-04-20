import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { withAdapter, withTempDataDir } from './__tests__/adapter.ts';
import {
  querySentinel,
  SENTINEL_MARKER,
  SENTINEL_SCHEMA,
  SENTINEL_TABLE,
} from './__tests__/sentinel.ts';

describe('sentinel initialization detection: legacy and adoption', () => {
  it('backfills sentinel across legacy dataDirs with tables, enums, sequences, functions, and non-public schemas', async () => {
    const cases = [
      {
        setupSql:
          'CREATE TABLE legacy_table (id int PRIMARY KEY); INSERT INTO legacy_table VALUES (1)',
        adapterSql: 'CREATE TABLE legacy_table (id int PRIMARY KEY)',
        verifySql: 'SELECT count(*)::int AS n FROM legacy_table',
        expected: 1,
      },
      {
        setupSql: "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
        adapterSql: "CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy')",
        verifySql: "SELECT count(*)::int AS n FROM pg_type WHERE typname = 'mood'",
        expected: 1,
      },
      {
        setupSql: 'CREATE SEQUENCE custom_seq START 5',
        adapterSql: 'CREATE SEQUENCE custom_seq START 5',
        verifySql:
          "SELECT count(*)::int AS n FROM pg_class WHERE relkind = 'S' AND relname = 'custom_seq'",
        expected: 1,
      },
      {
        setupSql: 'CREATE FUNCTION add_one(x int) RETURNS int AS $$ SELECT x + 1 $$ LANGUAGE sql',
        adapterSql: 'CREATE FUNCTION add_one(x int) RETURNS int AS $$ SELECT x + 1 $$ LANGUAGE sql',
        verifySql: "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'add_one'",
        expected: 1,
      },
      {
        setupSql: 'CREATE SCHEMA extra; CREATE TABLE extra.persisted (id int PRIMARY KEY)',
        adapterSql: 'CREATE SCHEMA extra; CREATE TABLE extra.persisted (id int PRIMARY KEY)',
        verifySql: 'SELECT count(*)::int AS n FROM extra.persisted',
        expected: 0,
      },
    ] as const;

    for (const testCase of cases) {
      await withTempDataDir(async (dataDir) => {
        const raw = new PGlite(dataDir);
        await raw.exec(testCase.setupSql);
        await raw.close();

        await withAdapter({ dataDir, sql: testCase.adapterSql }, async (adapter) => {
          const { rows } = await adapter.pglite.query<{ n: number }>(testCase.verifySql);
          expect(rows[0]?.n).toBe(testCase.expected);

          const sentinel = await querySentinel(adapter.pglite);
          expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
        });
      });
    }
  });

  it('adopts reserved schema and restores a missing sentinel on reopen', async () => {
    const sql = `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"; CREATE TABLE test_adopt (id int PRIMARY KEY)`;
    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async (first) => {
        const sentinel = await querySentinel(first.pglite);
        expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
      });

      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM test_adopt',
        );
        expect(rows[0]?.n).toBe(0);

        await second.pglite.exec(`DROP SCHEMA "${SENTINEL_SCHEMA}" CASCADE`);
      });

      await withAdapter({ dataDir, sql }, async (third) => {
        const restored = await querySentinel(third.pglite);
        expect(restored).toEqual({ marker: SENTINEL_MARKER, version: 1 });
      });
    });
  });

  it('succeeds when user SQL creates exact sentinel (idempotent writeSentinel)', async () => {
    const sql = [
      `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
      `CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
      `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('${SENTINEL_MARKER}', 1)`,
      'CREATE TABLE user_data (id int PRIMARY KEY)',
    ].join(';\n');

    await withTempDataDir(async (dataDir) => {
      await withAdapter({ dataDir, sql }, async (first) => {
        const sentinel = await querySentinel(first.pglite);
        expect(sentinel).toEqual({ marker: SENTINEL_MARKER, version: 1 });
      });

      await withAdapter({ dataDir, sql }, async (second) => {
        const { rows } = await second.pglite.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM user_data',
        );
        expect(rows[0]?.n).toBe(0);
      });
    });
  });
});
