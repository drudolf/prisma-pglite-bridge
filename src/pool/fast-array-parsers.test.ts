import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { setupPGlite } from '../__tests__/pglite.ts';
import { type TypesLike, wrapTypesWithFastArrayParsers } from './fast-array-parsers.ts';
import { PgBridgePool } from './index.ts';

const pglite = await setupPGlite();

// Mimics how @prisma/adapter-pg supplies its per-query `types` object: a
// `{ getTypeParser }` shaped value with no per-array fast path of its own.
// Stable per-OID parsers so reference-equality tests are meaningful.
const adapterStyleTypes = (custom: Record<number, (raw: string) => unknown> = {}): TypesLike => {
  const cache = new Map<string, (raw: string) => unknown>();
  const identity = (raw: string) => raw;
  return {
    getTypeParser: (oid, format = 'text') => {
      const key = `${oid}:${format}`;
      const cached = cache.get(key);
      if (cached) return cached;
      const parser = format === 'text' && custom[oid] ? custom[oid] : identity;
      cache.set(key, parser);
      return parser;
    },
  };
};

describe('wrapTypesWithFastArrayParsers — boundary behaviour', () => {
  it('returns the original parser for non-array OIDs', () => {
    const inner = adapterStyleTypes();
    const wrapped = wrapTypesWithFastArrayParsers(inner);
    // OID 17 (BYTEA scalar) is not in our array map
    expect(wrapped.getTypeParser(17, 'text')).toBe(inner.getTypeParser(17, 'text'));
  });

  it('returns the original parser for binary format on array OIDs', () => {
    const inner = adapterStyleTypes();
    const wrapped = wrapTypesWithFastArrayParsers(inner);
    expect(wrapped.getTypeParser(1001, 'binary')).toBe(inner.getTypeParser(1001, 'binary'));
  });

  it('returns a different parser for intercepted text-format array OIDs', () => {
    const inner = adapterStyleTypes();
    const wrapped = wrapTypesWithFastArrayParsers(inner);
    expect(wrapped.getTypeParser(1001, 'text')).not.toBe(inner.getTypeParser(1001, 'text'));
    expect(wrapped.getTypeParser(1007, 'text')).not.toBe(inner.getTypeParser(1007, 'text'));
  });

  it('uses the original element parser when building array fast-paths', () => {
    let elementCalls = 0;
    const innerByteaParser = (raw: string) => {
      elementCalls++;
      return Buffer.from(raw.slice(2), 'hex');
    };
    const inner: TypesLike = {
      getTypeParser: (oid, _format) => (oid === 17 ? innerByteaParser : (raw: string) => raw),
    };
    const wrapped = wrapTypesWithFastArrayParsers(inner);
    const arrParser = wrapped.getTypeParser(1001, 'text');
    const result = arrParser('{"\\\\x010203","\\\\xaabbcc"}') as Buffer[];
    expect(elementCalls).toBe(2);
    expect(result.map((b) => b.toString('hex'))).toEqual(['010203', 'aabbcc']);
  });

  it('handles NULL elements without invoking the element parser', () => {
    let elementCalls = 0;
    const inner: TypesLike = {
      getTypeParser: () => (raw: string) => {
        elementCalls++;
        return Number(raw);
      },
    };
    const wrapped = wrapTypesWithFastArrayParsers(inner);
    const arrParser = wrapped.getTypeParser(1007, 'text');
    expect(arrParser('{1,NULL,3}')).toEqual([1, null, 3]);
    expect(elementCalls).toBe(2);
  });

  it('skips the element transform for text-like array OIDs', () => {
    let elementCalls = 0;
    const inner: TypesLike = {
      getTypeParser: () => (raw: string) => {
        elementCalls++;
        return raw;
      },
    };
    const wrapped = wrapTypesWithFastArrayParsers(inner);
    const arrParser = wrapped.getTypeParser(1009, 'text');
    expect(arrParser('{a,b,c}')).toEqual(['a', 'b', 'c']);
    expect(elementCalls).toBe(0);
  });

  it('returns an empty array for `{}`', () => {
    const wrapped = wrapTypesWithFastArrayParsers(adapterStyleTypes());
    const arrParser = wrapped.getTypeParser(1009, 'text');
    expect(arrParser('{}')).toEqual([]);
  });
});

describe('PgBridgeClient — wraps types in pool.query', () => {
  it('round-trips BYTEA[] correctly', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      await pool.query('CREATE TABLE bytea_array_t (id int, chunks bytea[])');
      await pool.query(
        "INSERT INTO bytea_array_t VALUES (1, ARRAY[E'\\\\x010203'::bytea, E'\\\\xaabbcc'::bytea, NULL])",
      );
      const result = await pool.query('SELECT chunks FROM bytea_array_t WHERE id = 1');
      const chunks = result.rows[0].chunks as (Buffer | null)[];
      expect(chunks).toHaveLength(3);
      expect(chunks[0]?.toString('hex')).toBe('010203');
      expect(chunks[1]?.toString('hex')).toBe('aabbcc');
      expect(chunks[2]).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it('round-trips INT4[], TEXT[], BOOL[] correctly', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      await pool.query('CREATE TABLE arr_t (ints int[], txts text[], bools bool[])');
      await pool.query("INSERT INTO arr_t VALUES ('{1,2,3}', '{a,b,c}', '{true,false,true}')");
      const { rows } = await pool.query('SELECT ints, txts, bools FROM arr_t');
      expect(rows[0].ints).toEqual([1, 2, 3]);
      expect(rows[0].txts).toEqual(['a', 'b', 'c']);
      expect(rows[0].bools).toEqual([true, false, true]);
    } finally {
      await pool.end();
    }
  });

  it('preserves a caller-supplied types.getTypeParser for non-array OIDs', async () => {
    const pool = new PgBridgePool({ pglite });
    try {
      await pool.query('CREATE TABLE scalar_t (n int)');
      await pool.query('INSERT INTO scalar_t VALUES (42)');
      const userTypes: TypesLike = {
        getTypeParser: (oid) => (oid === 23 ? () => 'CUSTOMIZED' : (raw: string) => raw),
      };
      const result = await pool.query({
        text: 'SELECT n FROM scalar_t',
        rowMode: 'array',
        types: userTypes as unknown as pg.CustomTypesConfig,
      });
      expect(result.rows[0]).toEqual(['CUSTOMIZED']);
    } finally {
      await pool.end();
    }
  });
});
