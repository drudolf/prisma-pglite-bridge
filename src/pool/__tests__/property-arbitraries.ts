/**
 * Generators, canonical PG-array-output serializer, and projection helpers for
 * the pool fast-path property suites (fast-array-parsers / fast-query).
 * Spec: .claude/plans/fast-path-property-tests.md
 */
import { createRequire } from 'node:module';
import fc from 'fast-check';

import type { TypesLike } from '../fast-array-parsers.ts';

// ---------------------------------------------------------------------------
// Array-literal generation (P1–P3)
// ---------------------------------------------------------------------------

/** Nested raw-element texts; `null` marks a SQL NULL slot. Rectangular by construction. */
export type ElementTree = Array<string | null | ElementTree>;

export type ArrayLiteralScenario = {
  literal: string;
  tree: ElementTree;
};

const TEXT_LIKE_ARRAY_OIDS: readonly number[] = [
  1002, 1009, 1014, 1015, 1040, 1041, 1270, 2951, 651, 3907,
];
const ELEMENT_ARRAY_OID_PAIRS: ReadonlyArray<readonly [arrayOid: number, elementOid: number]> = [
  [1000, 16],
  [1001, 17],
  [1005, 21],
  [1007, 23],
  [1016, 20],
  [1017, 600],
  [1021, 700],
  [1022, 701],
  [1028, 26],
  [1187, 1186],
];

export const ELEMENT_OID_BY_ARRAY_OID: ReadonlyMap<number, number> = new Map(
  ELEMENT_ARRAY_OID_PAIRS,
);
export const ALL_WRAPPED_ARRAY_OIDS: readonly number[] = [
  ...TEXT_LIKE_ARRAY_OIDS,
  ...ELEMENT_ARRAY_OID_PAIRS.map(([arrayOid]) => arrayOid),
];
export const WRAPPED_ARRAY_OID_SET: ReadonlySet<number> = new Set(ALL_WRAPPED_ARRAY_OIDS);
// OID 1002 (_char) has no pg-types text parser (identity no-parse) — P2's
// round-trip is its only oracle; every other wrapped OID diffs against pg-types.
export const DIFFABLE_ARRAY_OIDS: readonly number[] = ALL_WRAPPED_ARRAY_OIDS.filter(
  (oid) => oid !== 1002,
);

// PG quotes an element iff it is empty, matches NULL case-insensitively, or
// contains braces, the delimiter, a double quote, a backslash, or whitespace;
// inside quotes `"` and `\` are backslash-escaped.
const QUOTE_REQUIRED = /[\s{},"\\]/;
const NULL_WORD = /^null$/i;

const serializeElement = (text: string): string =>
  text === '' || NULL_WORD.test(text) || QUOTE_REQUIRED.test(text)
    ? `"${text.replace(/([\\"])/g, '\\$1')}"`
    : text;

const serializeTree = (tree: ElementTree): string => {
  const parts = tree.map((node) =>
    node === null ? 'NULL' : Array.isArray(node) ? serializeTree(node) : serializeElement(node),
  );
  return `{${parts.join(',')}}`;
};

const treeDims = (tree: ElementTree): number[] => {
  const dims: number[] = [];
  let node: ElementTree[number] = tree;
  while (Array.isArray(node)) {
    dims.push(node.length);
    node = node[0] ?? null;
  }
  return dims;
};

/** Canonical PG array output; `lowerBounds` adds the `[l:u]…=` prefix per dimension. */
export const serializePgArrayLiteral = (
  tree: ElementTree,
  lowerBounds?: readonly number[],
): string => {
  const body = serializeTree(tree);
  if (lowerBounds === undefined) return body;
  const prefix = treeDims(tree)
    .map((size, i) => `[${lowerBounds[i] ?? 1}:${(lowerBounds[i] ?? 1) + size - 1}]`)
    .join('');
  return `${prefix}=${body}`;
};

const buildTree = (dims: readonly number[], flat: readonly (string | null)[]): ElementTree => {
  const [head, ...rest] = dims;
  if (head === undefined) return [];
  if (rest.length === 0) return [...flat.slice(0, head)];
  const childSize = rest.reduce((product, size) => product * size, 1);
  return Array.from(
    { length: head },
    (_, i): ElementTree => buildTree(rest, flat.slice(i * childSize, (i + 1) * childSize)),
  );
};

const pad2 = (value: number): string => String(value).padStart(2, '0');

// True text types carry the full quoting/escaping stress: specials, whitespace,
// empty string, and the literal NULL word in every casing.
const textElementArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 8 }) },
  {
    weight: 3,
    arbitrary: fc.string({
      unit: fc.constantFrom('{', '}', ',', '"', '\\', ' ', '\t', '\n', 'a', 'x', '0'),
      maxLength: 6,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      '',
      'NULL',
      'null',
      'NuLl',
      '\\',
      '"',
      '{}',
      'a,b',
      ' pad ',
      '\\x01',
    ),
  },
);

const octetArb = fc.integer({ min: 0, max: 255 });
// Syntactically VALID backend text only for uuid/inet/cidr/macaddr/timetz/numrange
// (tribunal condition): arbitrary text would couple the suite to today's
// incidental raw-string passthrough on both sides.
const inetElementArb: fc.Arbitrary<string> = fc
  .tuple(
    octetArb,
    octetArb,
    octetArb,
    octetArb,
    fc.oneof(fc.constant(null), fc.integer({ min: 0, max: 32 })),
  )
  .map(([a, b, c, d, mask]) =>
    mask === null ? `${a}.${b}.${c}.${d}` : `${a}.${b}.${c}.${d}/${mask}`,
  );
const cidrElementArb: fc.Arbitrary<string> = fc.oneof(
  octetArb.map((a) => `${a}.0.0.0/8`),
  fc.tuple(octetArb, octetArb).map(([a, b]) => `${a}.${b}.0.0/16`),
  fc.tuple(octetArb, octetArb, octetArb).map(([a, b, c]) => `${a}.${b}.${c}.0/24`),
  fc.tuple(octetArb, octetArb, octetArb, octetArb).map(([a, b, c, d]) => `${a}.${b}.${c}.${d}/32`),
);
const hexPairArb = octetArb.map((byte) => byte.toString(16).padStart(2, '0'));
const macaddrElementArb: fc.Arbitrary<string> = fc
  .tuple(hexPairArb, hexPairArb, hexPairArb, hexPairArb, hexPairArb, hexPairArb)
  .map((pairs) => pairs.join(':'));
const timetzElementArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 0, max: 23 }),
    fc.integer({ min: 0, max: 59 }),
    fc.integer({ min: 0, max: 59 }),
    fc.constantFrom('+00', '+02', '-08', '+05:30', '-11', '+14'),
  )
  .map(([h, m, s, tz]) => `${pad2(h)}:${pad2(m)}:${pad2(s)}${tz}`);
const numrangeElementArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('empty'),
  fc
    .tuple(
      fc.integer({ min: -999, max: 999 }),
      fc.integer({ min: 1, max: 999 }),
      fc.constantFrom('[', '('),
      fc.constantFrom(']', ')'),
    )
    .map(([lo, span, open, close]) => `${open}${lo},${lo + span}${close}`),
  fc.integer({ min: -999, max: 999 }).map((lo) => `[${lo},)`),
  fc.integer({ min: -999, max: 999 }).map((hi) => `(,${hi}]`),
);
const int2ElementArb: fc.Arbitrary<string> = fc.integer({ min: -32768, max: 32767 }).map(String);
const int4ElementArb: fc.Arbitrary<string> = fc
  .integer({ min: -2147483648, max: 2147483647 })
  .map(String);
const int8ElementArb: fc.Arbitrary<string> = fc.oneof(
  int4ElementArb,
  fc.constantFrom('9223372036854775807', '-9223372036854775808', '9007199254740993'),
);
const boolElementArb: fc.Arbitrary<string> = fc.constantFrom('t', 'f');
const byteaElementArb: fc.Arbitrary<string> = fc
  .uint8Array({ maxLength: 6 })
  .map((bytes) => `\\x${Buffer.from(bytes).toString('hex')}`);
// Exactly representable decimal text — avoids float-text canonicalization noise.
const exactFloatElementArb: fc.Arbitrary<string> = fc.oneof(
  fc.integer({ min: -1000, max: 1000 }).map(String),
  fc
    .tuple(fc.integer({ min: -50, max: 50 }), fc.constantFrom('.5', '.25', '.75', '.125'))
    .map(([whole, frac]) => `${whole}${frac}`),
);
const oidElementArb: fc.Arbitrary<string> = fc.integer({ min: 0, max: 4294967295 }).map(String);
const pointElementArb: fc.Arbitrary<string> = fc
  .tuple(exactFloatElementArb, exactFloatElementArb)
  .map(([x, y]) => `(${x},${y})`);
const intervalElementArb: fc.Arbitrary<string> = fc.constantFrom(
  '1 day',
  '2 days',
  '00:00:01',
  '01:02:03',
  '1 day 02:03:04',
  '2 mons',
  '1 year 2 mons 3 days',
);

// Element text is generated directly as per-type canonical PG output, never via
// JS-value round-trips — array STRUCTURE parsing is under test.
const ELEMENT_TEXT_ARBS: ReadonlyMap<number, fc.Arbitrary<string>> = new Map([
  [1002, textElementArb],
  [1009, textElementArb],
  [1014, textElementArb],
  [1015, textElementArb],
  [2951, fc.uuid()],
  [1041, inetElementArb],
  [651, cidrElementArb],
  [1040, macaddrElementArb],
  [1270, timetzElementArb],
  [3907, numrangeElementArb],
  [1005, int2ElementArb],
  [1007, int4ElementArb],
  [1016, int8ElementArb],
  [1000, boolElementArb],
  [1001, byteaElementArb],
  [1021, exactFloatElementArb],
  [1022, exactFloatElementArb],
  [1028, oidElementArb],
  [1017, pointElementArb],
  [1187, intervalElementArb],
]);

const lowerBoundArb: fc.Arbitrary<number> = fc
  .integer({ min: -3, max: 5 })
  .filter((lower) => lower !== 1);

export const arrayLiteralScenarioArb = (oid: number): fc.Arbitrary<ArrayLiteralScenario> => {
  const elementArb = ELEMENT_TEXT_ARBS.get(oid);
  if (elementArb === undefined) {
    throw new Error(`no element text generator for array OID ${oid}`);
  }
  const slotArb: fc.Arbitrary<string | null> = fc.oneof(
    { weight: 1, arbitrary: fc.constant(null) },
    { weight: 4, arbitrary: elementArb },
  );
  const populatedArb = fc
    .array(fc.integer({ min: 1, max: 6 }), { minLength: 1, maxLength: 3 })
    .chain((dims) => {
      const total = dims.reduce((product, size) => product * size, 1);
      return fc.record({
        dims: fc.constant(dims),
        flat: fc.array(slotArb, { minLength: total, maxLength: total }),
        // Bounds prefix ([l:u]= with l ≠ 1) is real backend output — both
        // parsers must handle it; disagreement is a candidate bug.
        lowers: fc.oneof(
          { weight: 3, arbitrary: fc.constant(null) },
          {
            weight: 1,
            arbitrary: fc.array(lowerBoundArb, {
              minLength: dims.length,
              maxLength: dims.length,
            }),
          },
        ),
      });
    })
    .map(({ dims, flat, lowers }): ArrayLiteralScenario => {
      const tree = buildTree(dims, flat);
      return { tree, literal: serializePgArrayLiteral(tree, lowers ?? undefined) };
    });
  return fc.oneof(
    // `{}` is the sole empty-array case and only in one dimension — no real
    // backend emits zero-sized inner dimensions.
    { weight: 1, arbitrary: fc.constant<ArrayLiteralScenario>({ literal: '{}', tree: [] }) },
    { weight: 9, arbitrary: populatedArb },
  );
};

// ---------------------------------------------------------------------------
// FastQuery receive-side sequences (P4–P5)
// ---------------------------------------------------------------------------

/** Full pg RowDescription field shape (FastQuery reads name/dataTypeID/format only). */
type GeneratedField = {
  name: string;
  dataTypeID: number;
  format: string;
  tableID: number;
  columnID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
};

export type SequenceMessage =
  | { kind: 'rowDescription'; fields: GeneratedField[] }
  | { kind: 'dataRow'; values: (string | null)[] }
  | { kind: 'commandComplete'; tag: string }
  | { kind: 'emptyQuery' }
  | { kind: 'readyForQuery' }
  | { kind: 'error'; message: string };

const KNOWN_COLUMN_OIDS: readonly number[] = [23, 25, 16, 1007, 1009];

const fieldArb: fc.Arbitrary<GeneratedField> = fc.record({
  name: fc.string({ maxLength: 8 }),
  dataTypeID: fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...KNOWN_COLUMN_OIDS) },
    { weight: 1, arbitrary: fc.integer({ min: 60000, max: 70000 }) },
  ),
  format: fc.constant('text'),
  tableID: fc.integer({ min: 0, max: 99999 }),
  columnID: fc.integer({ min: 0, max: 64 }),
  dataTypeSize: fc.constantFrom(-1, 1, 4, 8),
  dataTypeModifier: fc.constant(-1),
});

const columnValueArb = (dataTypeID: number): fc.Arbitrary<string> => {
  switch (dataTypeID) {
    case 23:
      return fc.integer({ min: -9999, max: 9999 }).map(String);
    case 16:
      return fc.constantFrom('t', 'f');
    case 1007:
      return fc.constantFrom('{1,2,3}', '{}', '{7,NULL}');
    case 1009:
      return fc.constantFrom('{a,b}', '{}', '{"x y"}');
    default:
      return fc.string({ maxLength: 6 });
  }
};

const dataRowArb = (fields: readonly GeneratedField[]): fc.Arbitrary<(string | null)[]> =>
  fields.length === 0
    ? fc.constant<(string | null)[]>([])
    : fc.tuple(
        ...fields.map((field) =>
          fc.oneof(
            { weight: 1, arbitrary: fc.constant<string | null>(null) },
            { weight: 3, arbitrary: columnValueArb(field.dataTypeID) },
          ),
        ),
      );

const commandTagArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('SELECT', 'UPDATE', 'DELETE', 'MERGE', 'MOVE', 'FETCH', 'COPY'),
      fc.integer({ min: 0, max: 9999 }),
    )
    .map(([command, rows]) => `${command} ${rows}`),
  fc
    .tuple(fc.integer({ min: 0, max: 99999 }), fc.integer({ min: 0, max: 9999 }))
    .map(([oid, rows]) => `INSERT ${oid} ${rows}`),
  fc.constantFrom(
    'CREATE TABLE',
    'BEGIN',
    'COMMIT',
    'ROLLBACK',
    'TRUNCATE TABLE',
    'ALTER TABLE',
    'DROP TABLE',
  ),
);

// Exactly ONE CommandComplete per sequence (tribunal condition): stock Query
// turns a second one into an array-of-results shape FastQuery never meets.
const rowDescriptionCycleArb: fc.Arbitrary<SequenceMessage[]> = fc
  .array(fieldArb, { maxLength: 4 })
  .chain((fields) =>
    fc
      .record({
        rows: fc.array(dataRowArb(fields), { maxLength: 4 }),
        tag: fc.oneof(
          { weight: 1, arbitrary: fc.constant(null) },
          { weight: 3, arbitrary: commandTagArb },
        ),
      })
      .map(({ rows, tag }): SequenceMessage[] => {
        const messages: SequenceMessage[] = [{ kind: 'rowDescription', fields }];
        for (const values of rows) {
          messages.push({ kind: 'dataRow', values });
        }
        if (tag !== null) {
          messages.push({ kind: 'commandComplete', tag });
        }
        messages.push({ kind: 'readyForQuery' });
        return messages;
      }),
  );

const noDataCycleArb: fc.Arbitrary<SequenceMessage[]> = commandTagArb.map(
  (tag): SequenceMessage[] => [{ kind: 'commandComplete', tag }, { kind: 'readyForQuery' }],
);

const emptyQueryCycleArb: fc.Arbitrary<SequenceMessage[]> = fc.constant<SequenceMessage[]>([
  { kind: 'emptyQuery' },
  { kind: 'readyForQuery' },
]);

const protocolCycleArb: fc.Arbitrary<SequenceMessage[]> = fc.oneof(
  { weight: 4, arbitrary: rowDescriptionCycleArb },
  { weight: 1, arbitrary: noDataCycleArb },
  { weight: 1, arbitrary: emptyQueryCycleArb },
);

type ParityTypesArm = 'plain' | 'throwing-row-parser';
type SettlementTypesArm = ParityTypesArm | 'throwing-get-type-parser';

type ParityScenario = {
  messages: SequenceMessage[];
  typesArm: ParityTypesArm;
  throwOid: number;
};

const INJECTED_FATAL_MESSAGE = 'injected fatal error';

const randomParityArb: fc.Arbitrary<ParityScenario> = fc
  .record({
    cycle: protocolCycleArb,
    typesArm: fc.constantFrom<ParityTypesArm>('plain', 'throwing-row-parser'),
    throwOid: fc.constantFrom(...KNOWN_COLUMN_OIDS),
    injectionSeed: fc.oneof(
      { weight: 3, arbitrary: fc.constant(null) },
      { weight: 1, arbitrary: fc.nat({ max: 1000 }) },
    ),
  })
  .map(
    ({ cycle, typesArm, throwOid, injectionSeed }): ParityScenario => ({
      messages:
        injectionSeed === null
          ? cycle
          : // handleError is TERMINAL (tribunal condition): truncate, never drive past it.
            [
              ...cycle.slice(0, injectionSeed % cycle.length),
              { kind: 'error', message: INJECTED_FATAL_MESSAGE },
            ],
      typesArm,
      throwOid,
    }),
  );

const canonicalColumnValue = (dataTypeID: number): string => {
  switch (dataTypeID) {
    case 23:
      return '1';
    case 16:
      return 't';
    case 1007:
      return '{1}';
    case 1009:
      return '{a}';
    default:
      return 'x';
  }
};

// Biased arm forcing the row-parser-throw × fatal-error corner to co-occur
// within the run budget (duplex biased-arm precedent).
const biasedParityArb: fc.Arbitrary<ParityScenario> = fc
  .record({
    throwOid: fc.constantFrom(...KNOWN_COLUMN_OIDS),
    leadingNullRows: fc.integer({ min: 0, max: 2 }),
    terminal: fc.constantFrom<'error' | 'readyForQuery'>('error', 'readyForQuery'),
  })
  .map(({ throwOid, leadingNullRows, terminal }): ParityScenario => {
    const field: GeneratedField = {
      name: 'c0',
      dataTypeID: throwOid,
      format: 'text',
      tableID: 0,
      columnID: 1,
      dataTypeSize: -1,
      dataTypeModifier: -1,
    };
    const messages: SequenceMessage[] = [{ kind: 'rowDescription', fields: [field] }];
    for (let i = 0; i < leadingNullRows; i++) {
      messages.push({ kind: 'dataRow', values: [null] });
    }
    messages.push({ kind: 'dataRow', values: [canonicalColumnValue(throwOid)] });
    messages.push(
      terminal === 'error'
        ? { kind: 'error', message: INJECTED_FATAL_MESSAGE }
        : { kind: 'readyForQuery' },
    );
    return { messages, typesArm: 'throwing-row-parser', throwOid };
  });

export const parityScenarioArb: fc.Arbitrary<ParityScenario> = fc.oneof(
  { weight: 4, arbitrary: randomParityArb },
  { weight: 1, arbitrary: biasedParityArb },
);

type SettlementScenario = {
  messages: SequenceMessage[];
  replay: SequenceMessage[];
  typesArm: SettlementTypesArm;
  throwOid: number;
};

const replayMessageArb: fc.Arbitrary<SequenceMessage> = fc.oneof(
  fc
    .array(fieldArb, { maxLength: 2 })
    .map((fields): SequenceMessage => ({ kind: 'rowDescription', fields })),
  fc
    .array(fc.oneof(fc.constant<string | null>(null), fc.string({ maxLength: 4 })), {
      maxLength: 3,
    })
    .map((values): SequenceMessage => ({ kind: 'dataRow', values })),
  commandTagArb.map((tag): SequenceMessage => ({ kind: 'commandComplete', tag })),
  fc.constant<SequenceMessage>({ kind: 'emptyQuery' }),
  fc.constant<SequenceMessage>({ kind: 'readyForQuery' }),
  fc.constant<SequenceMessage>({ kind: 'error', message: 'late replay error' }),
);

export const settlementScenarioArb: fc.Arbitrary<SettlementScenario> = fc
  .record({
    cycle: protocolCycleArb,
    typesArm: fc.constantFrom<SettlementTypesArm>(
      'plain',
      'throwing-row-parser',
      'throwing-get-type-parser',
    ),
    throwOid: fc.constantFrom(...KNOWN_COLUMN_OIDS),
    insertionSeed: fc.oneof(
      { weight: 2, arbitrary: fc.constant(null) },
      { weight: 1, arbitrary: fc.nat({ max: 1000 }) },
    ),
    replay: fc.array(replayMessageArb, { maxLength: 4 }),
  })
  .map(({ cycle, typesArm, throwOid, insertionSeed, replay }): SettlementScenario => {
    if (insertionSeed === null) {
      return { messages: cycle, replay, typesArm, throwOid };
    }
    const at = insertionSeed % (cycle.length + 1);
    return {
      // Mid-sequence fatal error WITHOUT truncation: the remaining tail is
      // post-settlement traffic — exactly P5's subject.
      messages: [
        ...cycle.slice(0, at),
        { kind: 'error', message: INJECTED_FATAL_MESSAGE },
        ...cycle.slice(at),
      ],
      replay,
      typesArm,
      throwOid,
    };
  });

type PinnedDivergenceCase = {
  fields: GeneratedField[];
  rows: (string | null)[][];
  tag: string | null;
};

// ≥1 column: with zero columns neither side ever calls getTypeParser.
export const pinnedDivergenceCaseArb: fc.Arbitrary<PinnedDivergenceCase> = fc
  .array(fieldArb, { minLength: 1, maxLength: 4 })
  .chain((fields) =>
    fc.record({
      fields: fc.constant(fields),
      rows: fc.array(dataRowArb(fields), { maxLength: 3 }),
      tag: fc.oneof(fc.constant(null), commandTagArb),
    }),
  );

export const makeScenarioTypes = (arm: SettlementTypesArm, throwOid: number): TypesLike => ({
  getTypeParser: (oid, format = 'text') => {
    if (arm === 'throwing-get-type-parser') {
      throw new Error('type resolver boom');
    }
    if (arm === 'throwing-row-parser' && oid === throwOid) {
      return () => {
        throw new Error(`row parser boom ${throwOid}`);
      };
    }
    switch (oid) {
      case 23:
        return (raw) => Number(raw);
      case 16:
        return (raw) => raw === 't';
      case 25:
        return (raw) => raw;
      default:
        return (raw) => `p${oid}|${format}|${raw}`;
    }
  },
});

// ---------------------------------------------------------------------------
// Stock pg.Query reference (P4)
// ---------------------------------------------------------------------------

export type ConnectionShim = { sync: () => void };

type StockResultLike = {
  rows: unknown[][];
  fields: GeneratedField[];
  rowCount: number | null;
  command: string | null;
  oid: number | null;
};

export type StockQueryInstance = {
  handleRowDescription: (msg: { fields: GeneratedField[] }) => void;
  handleDataRow: (msg: { fields: (string | null)[] }) => void;
  handleCommandComplete: (msg: { text: string }, connection: ConnectionShim) => void;
  handleEmptyQuery: (connection: ConnectionShim) => void;
  handleError: (err: Error, connection: ConnectionShim) => void;
  handleReadyForQuery: (connection: ConnectionShim) => void;
};

type StockQueryConfig = {
  name: string;
  text: string;
  values: unknown[];
  rowMode: 'array';
  types: TypesLike;
  callback: (err: Error | null, result?: StockResultLike) => void;
};

type StockQueryCtor = new (config: StockQueryConfig) => StockQueryInstance;

// pg's exports map serves ./lib/query.js, but @types/pg ships no declaration
// for it — typed require, the pg-lib-utils.d.ts approach kept inside __tests__.
const nodeRequire = createRequire(import.meta.url);
export const StockQuery: StockQueryCtor = nodeRequire('pg/lib/query.js') as StockQueryCtor;

// ---------------------------------------------------------------------------
// Settlement projection (P4)
// ---------------------------------------------------------------------------

type SettlementProjection = {
  rows: unknown[];
  fields: { name: string; dataTypeID: number; format: string | undefined }[];
  rowCount: number | null;
  command: string | null;
  oid: number | null;
};

type SettlementShape = {
  rows: unknown[];
  fields: ReadonlyArray<{ name: string; dataTypeID: number; format?: string | undefined }>;
  rowCount: number | null;
  command: string | null;
  oid: number | null;
};

export const projectSettlement = (result: SettlementShape): SettlementProjection => ({
  rows: result.rows,
  fields: result.fields.map((field) => ({
    name: field.name,
    dataTypeID: field.dataTypeID,
    format: field.format,
  })),
  rowCount: result.rowCount,
  command: result.command,
  oid: result.oid,
});

// Three-valued outcome model (tribunal condition): a synchronous handler throw
// is a settlement kind of its own, recorded on either side.
export type Outcome =
  | { kind: 'resolved'; projection: SettlementProjection }
  | { kind: 'rejected'; message: string }
  | { kind: 'handler-threw-synchronously'; message: string };

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
