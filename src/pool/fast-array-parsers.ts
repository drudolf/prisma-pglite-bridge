/**
 * Wraps a pg-style `{ getTypeParser }` object so array text-format reads
 * use `postgres-array@3` instead of pg-types' transitive `postgres-array@2`.
 *
 * `@prisma/adapter-pg` already uses postgres-array@3 for its own normalized
 * arrays (NUMERIC[], JSON[], TIMESTAMP[], etc.) but falls back to pg-types'
 * slow parser for:
 *   - BYTEA[] (captured at adapter-pg module load from pg-types)
 *   - everything else not in its customParsers map: BOOL[], INT2/4/8[],
 *     FLOAT4/8[], OID[], TEXT/VARCHAR/CHAR/UUID[], CIDR/INET/MACADDR[],
 *     INTERVAL[], TIMETZ[], NUMRANGE[], POINT[]
 *
 * The pg-types path costs O(n) JS object allocations per character of the
 * array literal — turning a 19MB BYTEA[] into 19M+ allocations. v3 uses
 * `indexOf` + `slice`, dropping the same workload to milliseconds.
 *
 * We don't override the *element* parser — we ask the wrapped object for
 * whatever parser it would have used. So adapter-pg's customParsers for
 * scalars (e.g. its `convertBytes` for OID 17) is preserved.
 */
import { parse as parseArrayV3 } from 'postgres-array';

export const isObject = (val: unknown): val is Record<string, unknown> => {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
};

type Parser = (raw: string) => unknown;
type GetTypeParser = (oid: number, format?: string) => Parser;

export interface TypesLike {
  getTypeParser: GetTypeParser;
}
export const isTypesLike = (value: unknown): value is TypesLike => {
  return isObject(value) && 'getTypeParser' in value && typeof value.getTypeParser === 'function';
};

// Array OIDs whose elements pg-types parses as raw strings (no transform).
// We can hand back a cached parser without consulting `originalGetTypeParser`.
const ARRAY_OID_TEXT_LIKE: ReadonlySet<number> = new Set([
  1002, // _char
  1009, // _text
  1014, // _bpchar
  1015, // _varchar
  1040, // _macaddr
  1041, // _inet
  1270, // _timetz
  2951, // _uuid
  651, // _cidr
  3907, // _numrange
]);

// Array OID → element scalar OID for OIDs that need a real element parser.
const ARRAY_OID_WITH_ELEMENT: ReadonlyMap<number, number> = new Map([
  [1000, 16], // _bool
  [1001, 17], // _bytea
  [1005, 21], // _int2
  [1007, 23], // _int4
  [1016, 20], // _int8
  [1017, 600], // _point
  [1021, 700], // _float4
  [1022, 701], // _float8
  [1028, 26], // _oid
  [1187, 1186], // _interval
]);

const FAST_TEXT_ARRAY_PARSER: Parser = (raw) => parseArrayV3(raw);

export const wrapTypesWithFastArrayParsers = <T extends TypesLike>(types: T): T => {
  // Bind the receiver, capture nothing else: pg's TypeOverrides resolves its
  // overrides at call time, so parsers registered via setTypeParser() after
  // wrapping stay live through `original`.
  const original = types.getTypeParser.bind(types);
  const wrapped: GetTypeParser = (oid, format = 'text') => {
    if (format === 'text') {
      if (ARRAY_OID_TEXT_LIKE.has(oid)) return FAST_TEXT_ARRAY_PARSER;
      const elementOid = ARRAY_OID_WITH_ELEMENT.get(oid);
      if (elementOid !== undefined) {
        const elementParser = original(elementOid, 'text');
        return (raw) => parseArrayV3(raw, elementParser);
      }
    }
    return original(oid, format);
  };
  // The spread intentionally drops prototype identity — the only contract
  // consumers rely on is `getTypeParser` (pg's Result reads nothing else).
  return { ...types, getTypeParser: wrapped };
};
