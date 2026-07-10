import { describe, expect, it } from 'vitest';

import { createStatementNameGenerator } from './statement-names.ts';

// Names are `ppb_<namespace>_<n>`: `<namespace>` is process-unique per
// factory call (a globalThis-keyed sequence shared across module copies),
// `<n>` counts insertion order within the instance. Tests assert name shape
// and uniqueness, never exact namespace ids — the sequence is shared
// process-wide, so ids depend on which tests ran before this one.
const NAME_SHAPE = /^ppb_(\d+)_(\d+)$/;

const parts = (name: string | undefined): { namespace: string; n: number } => {
  const match = NAME_SHAPE.exec(name ?? '');
  if (!match) throw new Error(`not a bridge statement name: ${String(name)}`);
  return { namespace: match[1] as string, n: Number(match[2]) };
};

describe('createStatementNameGenerator', () => {
  it('returns a stable ppb_<namespace>_<n> name for the same sql text', () => {
    const generate = createStatementNameGenerator();

    const first = generate({ sql: 'SELECT 1' });

    expect(first).toMatch(NAME_SHAPE);
    expect(generate({ sql: 'SELECT 1' })).toBe(first);
    expect(generate({ sql: 'SELECT 1' })).toBe(first);
  });

  it('assigns distinct names numbered by insertion order within one namespace', () => {
    const generate = createStatementNameGenerator();

    const first = parts(generate({ sql: 'SELECT 1' }));
    const second = parts(generate({ sql: 'SELECT 2' }));
    const third = parts(generate({ sql: 'SELECT 3' }));

    // One namespace per generator instance…
    expect(second.namespace).toBe(first.namespace);
    expect(third.namespace).toBe(first.namespace);
    // …with the per-instance counter advancing in insertion order.
    expect(second.n).toBe(first.n + 1);
    expect(third.n).toBe(first.n + 2);

    // Interleaved lookups do not disturb the mapping.
    expect(parts(generate({ sql: 'SELECT 2' }))).toEqual(second);
    expect(parts(generate({ sql: 'SELECT 1' }))).toEqual(first);
  });

  it('two factory instances produce disjoint name sets for identical SQL', () => {
    const a = createStatementNameGenerator();
    const b = createStatementNameGenerator();

    const texts = ['SELECT 1', 'SELECT 2', 'SELECT 3'];
    const aNames = texts.map((sql) => a({ sql }));
    const bNames = texts.map((sql) => b({ sql }));

    for (const name of [...aNames, ...bNames]) expect(name).toMatch(NAME_SHAPE);
    // Same SQL, same insertion position — never the same name: the
    // namespaces differ, so cross-client 42P05 collisions in the shared
    // PGlite session are structurally impossible.
    expect(parts(aNames[0]).namespace).not.toBe(parts(bNames[0]).namespace);
    const overlap = aNames.filter((name) => bNames.includes(name));
    expect(overlap).toEqual([]);
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

    expect(generate({ sql: 'SELECT 1' })).toMatch(NAME_SHAPE);
    expect(generate({ sql: 'SELECT 2' })).toBeUndefined();
  });

  it('enforces the limit per instance — a sibling generator has its own budget', () => {
    const a = createStatementNameGenerator(1);
    const b = createStatementNameGenerator(1);

    expect(a({ sql: 'SELECT 1' })).toMatch(NAME_SHAPE);
    expect(a({ sql: 'SELECT 2' })).toBeUndefined();

    // a's exhaustion does not consume b's slot.
    expect(b({ sql: 'SELECT 2' })).toMatch(NAME_SHAPE);
    expect(b({ sql: 'SELECT 3' })).toBeUndefined();
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

      // The first cacheable text still gets slot 0 — DDL took no slot.
      expect(parts(generate({ sql: 'SELECT 1' })).n).toBe(0);
    });

    it('names statements regardless of keyword case and leading whitespace', () => {
      const generate = createStatementNameGenerator();

      expect(generate({ sql: '  select 1' })).toMatch(NAME_SHAPE);
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

      expect(generate({ sql })).toMatch(NAME_SHAPE);
    });

    it('requires the leading keyword to be a whole word', () => {
      const generate = createStatementNameGenerator();

      expect(generate({ sql: 'selectx' })).toBeUndefined();
    });

    it('returns undefined for multi-statement strings (semicolon guard)', () => {
      const generate = createStatementNameGenerator();

      expect(
        generate({ sql: 'INSERT INTO x VALUES (1); INSERT INTO y VALUES (2)' }),
      ).toBeUndefined();
      // Single statement without semicolon still gets named.
      expect(generate({ sql: 'INSERT INTO x VALUES (1)' })).toMatch(NAME_SHAPE);
    });
  });
});
