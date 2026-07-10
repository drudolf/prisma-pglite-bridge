import { describe, expect, it } from 'vitest';

import { createStatementNameGenerator } from './statement-names.ts';

describe('createStatementNameGenerator', () => {
  it('returns a stable ppb_-prefixed name for the same sql text', () => {
    const generate = createStatementNameGenerator();

    const first = generate({ sql: 'SELECT 1' });

    expect(first).toMatch(/^ppb_\d+$/);
    expect(generate({ sql: 'SELECT 1' })).toBe(first);
    expect(generate({ sql: 'SELECT 1' })).toBe(first);
  });

  it('assigns distinct names numbered by insertion order', () => {
    const generate = createStatementNameGenerator();

    const first = generate({ sql: 'SELECT 1' });
    const second = generate({ sql: 'SELECT 2' });
    const third = generate({ sql: 'SELECT 3' });

    expect(first).toMatch(/^ppb_\d+$/);
    const base = Number(String(first).slice('ppb_'.length));
    expect(second).toBe(`ppb_${base + 1}`);
    expect(third).toBe(`ppb_${base + 2}`);

    // Interleaved lookups do not disturb the mapping.
    expect(generate({ sql: 'SELECT 2' })).toBe(second);
    expect(generate({ sql: 'SELECT 1' })).toBe(first);
  });

  it('keeps state per generator — a fresh generator starts numbering afresh', () => {
    const a = createStatementNameGenerator();
    const b = createStatementNameGenerator();

    // Same insertion position → same name, regardless of the sql text.
    expect(b({ sql: 'SELECT 999' })).toBe(a({ sql: 'SELECT 1' }));
  });

  it('stops naming new texts beyond the default limit of 500', () => {
    const generate = createStatementNameGenerator();

    const names = Array.from({ length: 500 }, (_, i) => generate({ sql: `SELECT ${i}` }));

    expect(names.every((name) => typeof name === 'string')).toBe(true);
    expect(new Set(names).size).toBe(500);

    expect(generate({ sql: 'SELECT 500' })).toBeUndefined();
  });

  it('keeps serving cached names after the limit is reached', () => {
    const generate = createStatementNameGenerator(2);

    const first = generate({ sql: 'SELECT 1' });
    const second = generate({ sql: 'SELECT 2' });

    expect(generate({ sql: 'SELECT 3' })).toBeUndefined();

    // Previously-cached texts keep their names, always.
    expect(generate({ sql: 'SELECT 1' })).toBe(first);
    expect(generate({ sql: 'SELECT 2' })).toBe(second);
    // Texts that arrived after the limit stay unnamed on retry too.
    expect(generate({ sql: 'SELECT 3' })).toBeUndefined();
  });

  it('honors a custom limit', () => {
    const generate = createStatementNameGenerator(1);

    expect(generate({ sql: 'SELECT 1' })).toMatch(/^ppb_\d+$/);
    expect(generate({ sql: 'SELECT 2' })).toBeUndefined();
  });

  describe('cacheability guard', () => {
    it.each([
      'CREATE TABLE "X" (id int)',
      'ALTER TABLE "X" ADD COLUMN y int',
      'DROP TABLE "X"',
      'TRUNCATE "X"',
      `SET application_name = 'y'`,
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
      'DEALLOCATE ALL',
    ])('returns undefined for non-cacheable statement: %s', (sql) => {
      const generate = createStatementNameGenerator();

      expect(generate({ sql })).toBeUndefined();
    });

    it('does not consume a cache slot for non-cacheable statements', () => {
      const generate = createStatementNameGenerator();

      expect(generate({ sql: 'CREATE TABLE "X" (id int)' })).toBeUndefined();

      // The first cacheable text still gets the first name — DDL took no slot.
      expect(generate({ sql: 'SELECT 1' })).toBe('ppb_0');
    });

    it('names statements regardless of keyword case and leading whitespace', () => {
      const generate = createStatementNameGenerator();

      expect(generate({ sql: '  select 1' })).toMatch(/^ppb_\d+$/);
    });

    it.each([
      'WITH t AS (SELECT 1) SELECT * FROM t',
      'MERGE INTO x USING y ON true WHEN MATCHED THEN DO NOTHING',
      'VALUES (1)',
      'INSERT INTO "X" (id) VALUES (1)',
      'UPDATE "X" SET id = 2 WHERE id = 1',
      'DELETE FROM "X" WHERE id = 1',
    ])('names cacheable statement: %s', (sql) => {
      const generate = createStatementNameGenerator();

      expect(generate({ sql })).toMatch(/^ppb_\d+$/);
    });

    it('requires the leading keyword to be a whole word', () => {
      const generate = createStatementNameGenerator();

      expect(generate({ sql: 'selectx' })).toBeUndefined();
    });
  });
});
