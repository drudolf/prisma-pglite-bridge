import fc from 'fast-check';
// Extensionless on purpose: pg's exports map resolves `./lib/*` to the runtime
// `.js`, while @types/pg's `./lib/*` maps to `.d.ts` — a `.js` suffix would
// defeat the type lookup (TS7016).
import TypeOverrides from 'pg/lib/type-overrides';
import { describe, expect, it } from 'vitest';

import {
  ALL_WRAPPED_ARRAY_OIDS,
  type ArrayLiteralScenario,
  arrayLiteralScenarioArb,
  DIFFABLE_ARRAY_OIDS,
  ELEMENT_OID_BY_ARRAY_OID,
  type ElementTree,
  serializePgArrayLiteral,
  WRAPPED_ARRAY_OID_SET,
} from './__tests__/property-arbitraries.ts';
import { type TypesLike, wrapTypesWithFastArrayParsers } from './fast-array-parsers.ts';

// Fresh per-suite TypeOverrides, NEVER the process-global pg.types registry
// (tribunal condition: global reads would make this suite order-sensitive to
// any test that ever calls setTypeParser globally).
const reference: TypesLike = new TypeOverrides() as unknown as TypesLike;
const wrapped: TypesLike = wrapTypesWithFastArrayParsers(reference);

const oidScenarioArb = (
  oids: readonly number[],
): fc.Arbitrary<{ oid: number; scenario: ArrayLiteralScenario }> =>
  fc
    .constantFrom(...oids)
    .chain((oid) => arrayLiteralScenarioArb(oid).map((scenario) => ({ oid, scenario })));

describe('wrapTypesWithFastArrayParsers properties', () => {
  it('P1: wrapped output deep-equals the pg-types reference for every diffable OID and literal', () => {
    fc.assert(
      fc.property(oidScenarioArb(DIFFABLE_ARRAY_OIDS), ({ oid, scenario }) => {
        const fast = wrapped.getTypeParser(oid, 'text')(scenario.literal);
        const ref = reference.getTypeParser(oid, 'text')(scenario.literal);
        expect(fast).toEqual(ref);
      }),
      { numRuns: 500 },
    );
  });

  // Element oracle defined PER WRAPPER BRANCH (tribunal condition —
  // FAST_TEXT_ARRAY_PARSER does no element delegation): text-like OIDs expect
  // the raw element text verbatim; element-OID branches expect
  // original(elementOid, 'text')(raw) resolved from the same wrapped source.
  const expectedParse = (oid: number, tree: ElementTree): unknown[] =>
    tree.map((node) => {
      if (node === null) return null;
      if (Array.isArray(node)) return expectedParse(oid, node);
      const elementOid = ELEMENT_OID_BY_ARRAY_OID.get(oid);
      return elementOid === undefined ? node : reference.getTypeParser(elementOid, 'text')(node);
    });

  // Covers all 20 OIDs including 1002 (_char): stock pg hands the literal back
  // unparsed while the wrapper parses it — a shipped, deliberate upgrade this
  // property PINS; whether it is desirable is a product question out of scope.
  it('P2: parsing the serialized literal yields the generated structure for all 20 OIDs', () => {
    fc.assert(
      fc.property(oidScenarioArb(ALL_WRAPPED_ARRAY_OIDS), ({ oid, scenario }) => {
        expect(wrapped.getTypeParser(oid, 'text')(scenario.literal)).toEqual(
          expectedParse(oid, scenario.tree),
        );
      }),
    );
  });

  // Recording stub with stable per-(oid, format) parser functions — function
  // identity is assertable without touching any global registry.
  const makeRecordingTypes = (): TypesLike => {
    const parsers = new Map<string, (raw: string) => unknown>();
    return {
      getTypeParser: (oid, format) => {
        const key = `${oid}:${format}`;
        let parser = parsers.get(key);
        if (parser === undefined) {
          parser = (raw: string): string => `stub:${key}:${raw}`;
          parsers.set(key, parser);
        }
        return parser;
      },
    };
  };

  const passthroughCaseArb: fc.Arbitrary<{ oid: number; format: 'text' | 'binary' }> = fc.oneof(
    fc.record({
      oid: fc.integer({ min: 0, max: 100000 }).filter((oid) => !WRAPPED_ARRAY_OID_SET.has(oid)),
      format: fc.constant<'text' | 'binary'>('text'),
    }),
    fc.record({
      oid: fc.oneof(
        fc.constantFrom(...ALL_WRAPPED_ARRAY_OIDS),
        fc.integer({ min: 0, max: 100000 }),
      ),
      format: fc.constant<'text' | 'binary'>('binary'),
    }),
  );

  it('P3: unmapped OIDs and binary format pass through with function identity', () => {
    fc.assert(
      fc.property(passthroughCaseArb, ({ oid, format }) => {
        const stub = makeRecordingTypes();
        const wrappedStub = wrapTypesWithFastArrayParsers(stub);
        expect(wrappedStub.getTypeParser(oid, format)).toBe(stub.getTypeParser(oid, format));
      }),
    );
  });

  // Tribunal condition: known real-PostgreSQL literals must serialize and
  // parse back exactly before the serializer is trusted as P1/P2's oracle.
  const SMOKE_TABLE: ReadonlyArray<{
    name: string;
    oid: number;
    tree: ElementTree;
    lowers?: number[];
    literal: string;
    parsed: unknown;
  }> = [
    {
      name: 'quoting, escaping, NULL vs "NULL"',
      oid: 1009,
      tree: ['a', 'b c', null, 'NULL', '"', '\\'],
      literal: '{a,"b c",NULL,"NULL","\\"","\\\\"}',
      parsed: ['a', 'b c', null, 'NULL', '"', '\\'],
    },
    {
      name: 'nested multidimensional',
      oid: 1007,
      tree: [
        ['1', '2'],
        ['3', '4'],
      ],
      literal: '{{1,2},{3,4}}',
      parsed: [
        [1, 2],
        [3, 4],
      ],
    },
    {
      name: 'bounds prefix',
      oid: 1009,
      tree: ['x', 'y'],
      lowers: [0],
      literal: '[0:1]={x,y}',
      parsed: ['x', 'y'],
    },
    {
      name: 'multidimensional bounds prefix',
      oid: 1009,
      tree: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      lowers: [0, 2],
      literal: '[0:1][2:3]={{a,b},{c,d}}',
      parsed: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    },
    { name: 'empty array', oid: 1009, tree: [], literal: '{}', parsed: [] },
    {
      name: 'bytea backslash escaping',
      oid: 1001,
      tree: ['\\x01ff'],
      literal: '{"\\\\x01ff"}',
      parsed: [Buffer.from([0x01, 0xff])],
    },
  ];

  it('serializer smoke table: canonical literals serialize and parse back exactly', () => {
    for (const entry of SMOKE_TABLE) {
      expect(serializePgArrayLiteral(entry.tree, entry.lowers), entry.name).toBe(entry.literal);
      expect(wrapped.getTypeParser(entry.oid, 'text')(entry.literal), entry.name).toEqual(
        entry.parsed,
      );
    }
  });
});
