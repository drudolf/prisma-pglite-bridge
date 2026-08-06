// Property suite for the copy-in sniffer. Spec (tribunal-reviewed):
// .claude/plans/copy-in-property-tests.md
//
// PHASE 1 AUTHORING NOTE: this suite is EXPECTED to be partially red against
// current production code — the E-string / dollar-quote word-boundary
// fail-open class is already confirmed by PGlite probes (see the lexer
// semantics comment in __tests__/copy-in-arbitraries.ts). Red cells and
// property failures map the defect for the separate fix design; nothing here
// may be weakened or allowlisted to force green.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { propertyRuns } from '../__tests__/property-runs.ts';
import {
  composedScenarioArb,
  copyCaptureTextArb,
  expectedVerdict,
  nonCopyTextArb,
  SENTINEL,
  triviaArb,
} from './__tests__/copy-in-arbitraries.ts';
import { type CopyInVerdict, sniffCopyIn } from './copy-in.ts';

// Measured at numRuns 50 first (spec instruction), then locked at 500: the
// whole file stays within the ~6 s budget. Routed through propertyRuns so the
// mutation config's FC_NUM_RUNS knob can reduce it; normal runs keep 500.
const CORE_RUNS = propertyRuns(500);

const VERDICTS: readonly CopyInVerdict[] = ['capture', 'reject-multi', 'not-copy-in'];

describe('sniffCopyIn properties', () => {
  it('P1: a composed text containing a copy-in is never classified not-copy-in (fail closed)', () => {
    fc.assert(
      fc.property(composedScenarioArb, (scenario) => {
        if (scenario.copyInCount === 0) return;
        expect(sniffCopyIn(scenario.text)).not.toBe('not-copy-in');
      }),
      { numRuns: CORE_RUNS },
    );
  });

  it('P2: the verdict matches the by-construction oracle exactly', () => {
    fc.assert(
      fc.property(composedScenarioArb, (scenario) => {
        expect(sniffCopyIn(scenario.text)).toBe(expectedVerdict(scenario));
      }),
      { numRuns: CORE_RUNS },
    );
  });

  it('P3a: prepending/appending comments or whitespace never changes the verdict', () => {
    fc.assert(
      fc.property(composedScenarioArb, triviaArb, triviaArb, (scenario, pre, post) => {
        expect(sniffCopyIn(`${pre}${scenario.text}${post}`)).toBe(sniffCopyIn(scenario.text));
      }),
    );
  });

  it("P3b: appending ; plus trailing whitespace to a 'capture' text keeps 'capture'", () => {
    fc.assert(
      fc.property(copyCaptureTextArb, fc.constantFrom('', ' ', '\n', '\t \n'), (text, ws) => {
        expect(sniffCopyIn(text)).toBe('capture');
        expect(sniffCopyIn(`${text};${ws}`)).toBe('capture');
      }),
    );
  });

  it("P3c: appending a non-copy statement to a 'capture' text yields 'reject-multi'", () => {
    fc.assert(
      fc.property(copyCaptureTextArb, nonCopyTextArb, (captureText, nonCopyText) => {
        expect(sniffCopyIn(`${captureText}; ${nonCopyText}`)).toBe('reject-multi');
      }),
    );
  });

  // Uniform per-character case maps: keyword case is insensitive, string and
  // comment contents are inert, and both occurrences of a dollar tag are
  // transformed identically so delimiter closure is preserved.
  const swapCase = (text: string): string =>
    text
      .split('')
      .map((ch) => {
        const lower = ch.toLowerCase();
        return ch === lower ? ch.toUpperCase() : lower;
      })
      .join('');

  it('P3d: uniform letter-case transforms never change the verdict', () => {
    fc.assert(
      fc.property(
        composedScenarioArb,
        fc.constantFrom<'lower' | 'upper' | 'swap'>('lower', 'upper', 'swap'),
        (scenario, mode) => {
          const transformed =
            mode === 'lower'
              ? scenario.text.toLowerCase()
              : mode === 'upper'
                ? scenario.text.toUpperCase()
                : swapCase(scenario.text);
          expect(sniffCopyIn(transformed)).toBe(sniffCopyIn(scenario.text));
        },
      ),
    );
  });

  it("P3e: wrapping any text in a fresh dollar quote yields 'not-copy-in'", () => {
    fc.assert(
      fc.property(composedScenarioArb, (scenario) => {
        let i = 0;
        // Excluding the unterminated `$q<i>` prefix too rules out straddle
        // matches with the closing delimiter.
        while (scenario.text.includes(`$q${i}`)) i++;
        const tag = `q${i}`;
        expect(sniffCopyIn(`SELECT $${tag}$${scenario.text}$${tag}$`)).toBe('not-copy-in');
      }),
    );
  });

  const arbitraryTextArb = fc.oneof(
    { arbitrary: fc.string({ unit: 'binary', maxLength: 2000 }), weight: 2 },
    {
      arbitrary: fc.string({
        unit: fc.constantFrom(
          "'",
          '\\',
          '$',
          'e',
          'E',
          ';',
          '-',
          '/',
          '*',
          '"',
          '\n',
          ' ',
          'a',
          '1',
          '_',
          '\u{10437}',
        ),
        maxLength: 400,
      }),
      weight: 2,
    },
    {
      arbitrary: fc.constantFrom(
        "E'",
        "e'\\",
        '$',
        '$$',
        '$tag$',
        "'",
        '/*',
        '/* /*',
        '--',
        '\\',
        'COPY t FROM STDIN $$',
        `COPY t FROM STDIN WITH (DELIMITER '`,
      ),
      weight: 1,
    },
  );

  it('P4: total function over arbitrary bounded unicode', { timeout: 15_000 }, () => {
    fc.assert(
      fc.property(arbitraryTextArb, (text) => {
        expect(VERDICTS).toContain(sniffCopyIn(text));
      }),
      { numRuns: propertyRuns(300) },
    );
  });
});

// ---------------------------------------------------------------------------
// Enumerated characterization table (tribunal condition): the full product of
// opener × preceding char × flavor × parity, each cell asserting the
// PG-CORRECT verdict derived from the lexer-semantics spec comment. Pre-fix,
// red cells ARE the map of the word-boundary class.
//
// Axis adaptation for the $tag$ opener (documented deviation): backslash
// flavor/parity are lexically inert inside dollar quotes, so the dollar rows
// repurpose the two axes as closure (closer present/absent) × tag style
// (named/anonymous) to keep every cell meaningful.
// ---------------------------------------------------------------------------

const SENT_TAIL = `; COPY ${SENTINEL} FROM STDIN`;

type PrecedingKind = 'glued' | 'boundary';
type Preceding = { label: string; kind: PrecedingKind; stringPrefix: string; dollarPrefix: string };

const PRECEDING: readonly Preceding[] = [
  // Realized inside identifier context for the glued classes so the digit
  // row avoids PG's numeric trailing-junk rule (0e' is a lexer error; a0e'
  // is identifier + string — probed).
  { label: 'start-of-token', kind: 'boundary', stringPrefix: '', dollarPrefix: '' },
  { label: 'letter', kind: 'glued', stringPrefix: 'SELECT x', dollarPrefix: 'SELECT 1 AS a' },
  { label: 'digit', kind: 'glued', stringPrefix: 'SELECT a0', dollarPrefix: 'SELECT 1 AS a0' },
  { label: 'underscore', kind: 'glued', stringPrefix: 'SELECT a_', dollarPrefix: 'SELECT 1 AS a_' },
  { label: 'dollar', kind: 'glued', stringPrefix: 'SELECT a$', dollarPrefix: 'SELECT 1 AS a$' },
  // High-bit byte: PG's ident_cont includes \200-\377, so a non-ASCII char
  // glues the opener to the preceding identifier exactly like an ASCII word
  // char. Covers the scanner's `charCodeAt >= 0x80` glue branch. PGlite-probed:
  // `SELECT aäe'…'` → identifier `aäe` + standard string; `aä$tag$` → one
  // identifier (the ; splits and the trailing COPY is a real second statement).
  { label: 'high-bit', kind: 'glued', stringPrefix: 'SELECT aä', dollarPrefix: 'SELECT 1 AS aä' },
  { label: 'punctuation', kind: 'boundary', stringPrefix: 'SELECT 1+', dollarPrefix: 'SELECT 1+' },
  { label: 'whitespace', kind: 'boundary', stringPrefix: 'SELECT ', dollarPrefix: 'SELECT ' },
];

type Flavor = 'standard' | 'estring';
type Parity = 'even' | 'odd';

// PG-correct verdict for a string-opener cell, derived from the lexer
// semantics (NOT from the scanner):
// - glued preceding char → the e/E belongs to the word; the quote opens a
//   STANDARD string.
//   - standard-flavor body (trailing backslash run only): the string closes
//     at its final quote regardless of parity; the ; splits; the copy-in
//     follows → 'reject-multi'.
//   - estring-flavor body (leading \' sequence): the standard reading closes
//     at the quote inside \', and the remainder (x…\…') fails to lex (stray
//     backslash / reopened unterminated string). Parse-first: nothing
//     executes → 'not-copy-in'.
// - boundary preceding char → genuine E-string: the trailing backslash run
//   escapes the closing quote when odd.
//   - even → closes; ; splits → 'reject-multi'.
//   - odd → unterminated string, the whole text fails to lex →
//     'not-copy-in'.
const stringCellExpected = (kind: PrecedingKind, flavor: Flavor, parity: Parity): CopyInVerdict => {
  if (kind === 'glued') return flavor === 'standard' ? 'reject-multi' : 'not-copy-in';
  return parity === 'even' ? 'reject-multi' : 'not-copy-in';
};

type Cell = [label: string, text: string, expected: CopyInVerdict];

const stringCells: Cell[] = (['e', 'E'] as const).flatMap((opener) =>
  PRECEDING.flatMap((preceding) =>
    (['standard', 'estring'] as const).flatMap((flavor) =>
      (['even', 'odd'] as const).map((parity): Cell => {
        const run = '\\'.repeat(parity === 'even' ? 2 : 1);
        const body = flavor === 'standard' ? `x${run}` : `\\'x${run}`;
        const text = `${preceding.stringPrefix}${opener}'${body}'${SENT_TAIL}`;
        return [
          `${opener}' × ${preceding.label} × ${flavor} × ${parity}`,
          text,
          stringCellExpected(preceding.kind, flavor, parity),
        ];
      }),
    ),
  ),
);

type Closure = 'closed' | 'unclosed';

// PG-correct verdict for a dollar-opener cell:
// - glued → the whole $-run extends the preceding identifier (closed or not,
//   named tag or not); the statement is a complete alias, the ; splits →
//   'reject-multi'. PGlite-probed for a$tag$, a$tag$x, a$$x, a$$tag$x$tag$.
// - boundary → a real dollar quote: closed → literal + split →
//   'reject-multi'; unclosed → unterminated dollar quote, the text fails to
//   lex → 'not-copy-in'.
const dollarCellExpected = (kind: PrecedingKind, closure: Closure): CopyInVerdict => {
  if (kind === 'glued') return 'reject-multi';
  return closure === 'closed' ? 'reject-multi' : 'not-copy-in';
};

const dollarCells: Cell[] = PRECEDING.flatMap((preceding) =>
  (['closed', 'unclosed'] as const).flatMap((closure) =>
    (['named', 'anonymous'] as const).map((tagStyle): Cell => {
      const delim = tagStyle === 'named' ? '$tag$' : '$$';
      const text = `${preceding.dollarPrefix}${delim}x${closure === 'closed' ? delim : ''}${SENT_TAIL}`;
      return [
        `$tag$ × ${preceding.label} × ${closure} × ${tagStyle}`,
        text,
        dollarCellExpected(preceding.kind, closure),
      ];
    }),
  ),
);

// Digits-only pseudo-tags live exclusively here (tribunal condition): $1$ is
// not a PG delimiter — $1 is a positional parameter — but it matched the
// pre-fix scanner's tag regex. PGlite-probed: J/K/L rows in the arbitraries
// file.
//
// The two whitespace-preceded rows are a SAFE structural over-rejection. PG
// reads `$1` as a parameter, then `$x$…`/`$` as an unterminated dollar quote
// or stray `$`, and rejects the WHOLE text (PGlite-probed: "unterminated
// dollar-quoted string" / "syntax error at or near \"$\"") — no COPY ever
// executes, so both not-copy-in and reject-multi are instance-safe. The
// tightened scanner no longer opens a fake quote on `$1$`, so the `;` splits
// and it returns reject-multi (fail-closed). PG-parity (not-copy-in, letting
// PG surface its own syntax error) would require modeling positional
// parameters and re-lexing the unterminated quote — large machinery for zero
// safety gain on malformed SQL; the fail-closed verdict is the correct target.
const pseudoTagCells: Cell[] = [
  [
    '$1$ × whitespace × closed (param + unterminated $x$ quote; PG rejects the text — safe over-reject)',
    `SELECT $1$x$1$${SENT_TAIL}`,
    'reject-multi',
  ],
  [
    '$1$ × whitespace × unclosed (param + stray $; PG rejects the text — safe over-reject)',
    `SELECT $1$x${SENT_TAIL}`,
    'reject-multi',
  ],
  [
    '$1$ × letter × unclosed (a$1$x is ONE identifier; the ; splits)',
    `SELECT 1 AS a$1$x${SENT_TAIL}`,
    'reject-multi',
  ],
  [
    '$1$ × letter × closed (a$1$x$1$ is ONE identifier; the ; splits)',
    `SELECT 1 AS a$1$x$1$${SENT_TAIL}`,
    'reject-multi',
  ],
];

describe('characterization table: word-boundary openers', () => {
  it.each([...stringCells, ...dollarCells, ...pseudoTagCells])('%s', (_label, text, expected) => {
    expect(sniffCopyIn(text)).toBe(expected);
  });
});
