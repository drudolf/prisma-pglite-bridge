import type pg from 'pg';
// Extensionless on purpose: pg's exports map resolves `./lib/*` to the runtime
// `.js`, while @types/pg's `./lib/*` maps to `.d.ts` — a `.js` suffix would
// defeat the type lookup (TS7016).
import TypeOverrides from 'pg/lib/type-overrides';
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

type ElementParser = (raw: string) => unknown;

// The real pg TypeOverrides (pg/lib/type-overrides.js) resolves every parser
// through `this.getOverrides(format)`, so its getTypeParser only works when
// invoked with a receiver. @types/pg mistypes the returned parser as
// `(oid: number) => any`, hence the narrowing cast to the bridge's shape.
interface TypeOverridesLike extends TypesLike {
  setTypeParser: (oid: number, parseFn: ElementParser) => void;
}
const realTypeOverrides = (): TypeOverridesLike =>
  new TypeOverrides() as unknown as TypeOverridesLike;

// Mimics the TypeOverrides mechanism: a PROTOTYPE getTypeParser that reads
// instance state through `this`. Deliberately class methods, not arrow
// properties — arrows would be auto-bound and could not detect an unbound call.
class PrototypeStateTypes {
  private readonly text: Record<number, ElementParser> = {
    23: (raw) => Number(raw),
  };

  private getOverrides(format: string): Record<number, ElementParser> {
    return format === 'text' ? this.text : {};
  }

  getTypeParser(oid: number, format = 'text'): ElementParser {
    return this.getOverrides(format)[oid] ?? ((raw: string) => `scalar:${oid}:${raw}`);
  }
}

describe('wrapTypesWithFastArrayParsers — this-dependent types objects (TypeOverrides)', () => {
  it('does not read unrelated own getters while preserving bound dynamic delegation', () => {
    const inner: TypesLike & { prefix: string; readonly unrelated: never } = {
      prefix: 'before',
      getTypeParser(oid, format = 'text') {
        return (raw) => `${this.prefix}:${oid}:${format}:${raw}`;
      },
      get unrelated(): never {
        throw new Error('unrelated getter read');
      },
    };

    const wrapped = wrapTypesWithFastArrayParsers(inner);
    inner.prefix = 'after';

    expect(wrapped.getTypeParser(17, 'binary')('value')).toBe('after:17:binary:value');
  });

  it('resolves array element parsers through a real pg TypeOverrides', () => {
    const wrapped = wrapTypesWithFastArrayParsers(realTypeOverrides());
    // _int8 (1016) → element OID 20, which pg leaves as a string by default
    const arrParser = wrapped.getTypeParser(1016, 'text');
    expect(arrParser('{1,2}')).toEqual(['1', '2']);
  });

  it('falls through to the real pg TypeOverrides for non-array OIDs', () => {
    const wrapped = wrapTypesWithFastArrayParsers(realTypeOverrides());
    const parser = wrapped.getTypeParser(20, 'text');
    expect(parser('42')).toBe('42');
  });

  it('delegates binary-format requests through the real pg TypeOverrides', () => {
    const wrapped = wrapTypesWithFastArrayParsers(realTypeOverrides());
    expect(typeof wrapped.getTypeParser(20, 'binary')).toBe('function');
  });

  it('still returns the fast parser for text-like array OIDs on a real pg TypeOverrides', () => {
    const wrapped = wrapTypesWithFastArrayParsers(realTypeOverrides());
    expect(wrapped.getTypeParser(1009, 'text')('{a,b}')).toEqual(['a', 'b']);
  });

  it('returns parsers registered on the original TypeOverrides after wrapping', () => {
    const overrides = realTypeOverrides();
    const wrapped = wrapTypesWithFastArrayParsers(overrides);
    const timesTen = (raw: string) => Number(raw) * 10;
    overrides.setTypeParser(20, timesTen);
    expect(wrapped.getTypeParser(20, 'text')).toBe(timesTen);
  });

  it('uses element parsers registered on the original TypeOverrides after wrapping', () => {
    const overrides = realTypeOverrides();
    const wrapped = wrapTypesWithFastArrayParsers(overrides);
    overrides.setTypeParser(20, (raw) => Number(raw) * 10);
    expect(wrapped.getTypeParser(1016, 'text')('{2,3}')).toEqual([20, 30]);
  });

  it('resolves element parsers via a prototype getTypeParser that reads instance state', () => {
    const wrapped = wrapTypesWithFastArrayParsers(new PrototypeStateTypes());
    expect(wrapped.getTypeParser(1007, 'text')('{1,2}')).toEqual([1, 2]);
  });

  it('falls through non-array OIDs via a prototype getTypeParser', () => {
    const wrapped = wrapTypesWithFastArrayParsers(new PrototypeStateTypes());
    expect(wrapped.getTypeParser(17, 'text')('abc')).toBe('scalar:17:abc');
  });

  it('leaves this-free closure types objects working across all branches', () => {
    const inner = adapterStyleTypes({ 23: (raw) => Number(raw) });
    const wrapped = wrapTypesWithFastArrayParsers(inner);
    expect(wrapped.getTypeParser(1007, 'text')('{1,2}')).toEqual([1, 2]);
    expect(wrapped.getTypeParser(17, 'text')).toBe(inner.getTypeParser(17, 'text'));
    expect(wrapped.getTypeParser(1001, 'binary')).toBe(inner.getTypeParser(1001, 'binary'));
    expect(wrapped.getTypeParser(1009, 'text')('{a,b}')).toEqual(['a', 'b']);
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
