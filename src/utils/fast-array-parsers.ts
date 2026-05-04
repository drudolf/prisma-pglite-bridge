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

// Array OID → element scalar OID. `undefined` means no element transform —
// pg-types only registers a `String(val)` no-op for these (text-likes).
const ARRAY_OID_TO_ELEMENT_OID: ReadonlyMap<number, number | undefined> = new Map([
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
  [1002, undefined], // _char
  [1009, undefined], // _text
  [1014, undefined], // _bpchar
  [1015, undefined], // _varchar
  [1040, undefined], // _macaddr
  [1041, undefined], // _inet
  [1270, undefined], // _timetz
  [2951, undefined], // _uuid
  [651, undefined], // _cidr
  [3907, undefined], // _numrange
]);

const buildFastParser = (
  originalGetTypeParser: GetTypeParser,
  elementOid: number | undefined,
): Parser => {
  if (elementOid === undefined) return (raw) => parseArrayV3(raw);
  const elementParser = originalGetTypeParser(elementOid, 'text');
  return (raw) => parseArrayV3(raw, elementParser);
};

export const wrapTypesWithFastArrayParsers = <T extends TypesLike>(types: T): T => {
  const original = types.getTypeParser;
  const wrapped: GetTypeParser = (oid, format = 'text') => {
    if (format === 'text' && ARRAY_OID_TO_ELEMENT_OID.has(oid)) {
      return buildFastParser(original, ARRAY_OID_TO_ELEMENT_OID.get(oid));
    }
    return original(oid, format);
  };
  return { ...types, getTypeParser: wrapped };
};
