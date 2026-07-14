import { describe, expect, it } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { decodeStatementCacheInvalidation } from './deallocate.ts';

// Boots once for the parse_ident oracle at the bottom; the grammar tables
// never touch it. reset: false — the oracle is read-only (no tables, no
// prepared state, nothing to reset between tests).
const pglite = await setupPGlite({ reset: false });

// Pure lexical contract for the bounded DEALLOCATE/DISCARD decoder (plan:
// .claude/plans/bounded-deallocate-identifier-decoder.md, "Recognized
// grammar"). The scanner accepts exactly
//   ws* DISCARD ws+ ALL trailer
//   ws* DEALLOCATE ws+ (PREPARE ws+)? target trailer
// with ws = ASCII space/tab/LF/CR/FF/VT, ASCII-only keyword folding, and
// PostgreSQL-style identifier decoding (regular identifiers fold A-Z only;
// delimited identifiers keep exact content with "" unescaping to one quote).
// Everything outside that language returns null — fail closed: an uncertain
// command evicts nothing (bounded 26000), never guesses (42P05).
describe('decodeStatementCacheInvalidation — accepted grammar', () => {
  it.each([
    'DEALLOCATE ALL',
    'deallocate all',
    'DeAlLoCaTe aLl',
    '  DEALLOCATE ALL',
    '\tDEALLOCATE\nALL\r',
    'DEALLOCATE\vALL', // VT separator — probe-confirmed against PGlite
    'DEALLOCATE\fALL', // FF separator — probe-confirmed against PGlite
    '\v\fDEALLOCATE ALL\f\v',
    'DEALLOCATE ALL;',
    'DEALLOCATE ALL ; ',
    'DEALLOCATE PREPARE ALL',
    'DEALLOCATE prepare all',
    'DISCARD ALL',
    'discard all',
    ' \tDISCARD ALL ; ',
    'DISCARD\fALL\v;',
  ])('decodes %j as session-wide', (sql) => {
    expect(decodeStatementCacheInvalidation(sql)).toEqual({ all: true });
  });

  it.each<[sql: string, name: string]>([
    // The PREPARE matrix — the optional keyword is consumed only via
    // lookahead to a syntactically complete target; otherwise PREPARE is
    // itself the target (PGlite probe: after PREPARE "prepare" AS SELECT 1,
    // bare DEALLOCATE prepare validly deallocates it). Decoding
    // DEALLOCATE PREPARE foo as { name: 'prepare' } would be a genuine
    // false eviction.
    ['DEALLOCATE PREPARE foo', 'foo'],
    ['DEALLOCATE PREPARE "a""b"', 'a"b'],
    ['DEALLOCATE PREPARE', 'prepare'],
    ['DEALLOCATE prepare', 'prepare'],
    ['DEALLOCATE PREPARE;', 'prepare'],
    ['DEALLOCATE PREPARE PREPARE', 'prepare'], // keyword, then a target named prepare
    ['DEALLOCATE "PREPARE"', 'PREPARE'], // quoted PREPARE is always a target
    // Regular identifiers — ASCII letters fold, _ / digits / $ pass through.
    ['DEALLOCATE _name', '_name'],
    ['DEALLOCATE name9', 'name9'],
    ['DEALLOCATE dollar$name', 'dollar$name'],
    ['DEALLOCATE FQ_FOLD', 'fq_fold'],
    ['\vDEALLOCATE\ffoo\v;\f', 'foo'],
    // Non-ASCII code units pass through unfolded, code unit for code unit —
    // no Unicode normalization, no JS toLowerCase.
    ['DEALLOCATE MÜNZE', 'mÜnze'],
    ['DEALLOCATE münze', 'münze'],
    ['DEALLOCATE Статистика', 'Статистика'],
    ['DEALLOCATE 統計', '統計'],
    ['DEALLOCATE \u{20000}', '\u{20000}'], // U+20000 — a UTF-16 surrogate pair
    ['DEALLOCATE A\u{20000}Z', 'a\u{20000}z'], // ASCII folding around the pair
    ['DEALLOCATE ÀLL', 'Àll'], // non-ASCII lookalike of ALL is a name, not session-wide
    // Delimited identifiers — exact content; "" decodes to one quote.
    ['DEALLOCATE "fq-hyphen"', 'fq-hyphen'],
    ['DEALLOCATE "MiXeD"', 'MiXeD'],
    ['DEALLOCATE "all"', 'all'],
    ['DEALLOCATE "ALL"', 'ALL'],
    ['DEALLOCATE "a""b"', 'a"b'],
    ['DEALLOCATE "a""b""c"', 'a"b"c'],
    ['DEALLOCATE """"', '"'],
    ['DEALLOCATE "sp ace;\t-- /* not a comment */"', 'sp ace;\t-- /* not a comment */'],
    ['DEALLOCATE\n"a""b"\r;', 'a"b'],
    // Quoted-adjacency targets — a `"` opens a delimited identifier and
    // cannot continue the preceding keyword, so zero whitespace after
    // DEALLOCATE / optional PREPARE is an unambiguous token boundary.
    ['DEALLOCATE"foo"', 'foo'],
    ['DEALLOCATE"a-b"', 'a-b'],
    ['DEALLOCATE"a""b"', 'a"b'],
    ['deallocate"mÜnze"', 'mÜnze'],
    ['DEALLOCATE"ALL"', 'ALL'], // quoted ALL is a name, never { all: true }
    ['DEALLOCATE PREPARE"a-b"', 'a-b'],
    ['deallocate prepare"a-b"', 'a-b'], // mixed-case keyword variant
    ['DEALLOCATE"a-b" ', 'a-b'], // trailing whitespace
    ['DEALLOCATE"a-b";', 'a-b'], // one permitted semicolon
    ['DEALLOCATE"a-b" ; ', 'a-b'],
    ['DEALLOCATE PREPARE"a-b";', 'a-b'],
    // Exact spellings longer than 63 UTF-8 bytes come back in full — pg's
    // parsedStatements is keyed by the original protocol name, never by
    // PostgreSQL's truncated server identity.
    [`DEALLOCATE ${'x'.repeat(70)}`, 'x'.repeat(70)],
    [`DEALLOCATE "${'y'.repeat(70)}"`, 'y'.repeat(70)],
  ])('decodes %j as name %j', (sql, name) => {
    expect(decodeStatementCacheInvalidation(sql)).toEqual({ name });
  });

  it('keeps MÜNZE and münze distinct — ASCII-only folding never collides them', () => {
    // JavaScript toLowerCase would fold BOTH spellings to münze and evict
    // the wrong live statement; PGlite folds only ASCII A-Z.
    expect(decodeStatementCacheInvalidation('DEALLOCATE MÜNZE')).toEqual({ name: 'mÜnze' });
    expect(decodeStatementCacheInvalidation('DEALLOCATE münze')).toEqual({ name: 'münze' });
  });
});

describe('decodeStatementCacheInvalidation — rejected inputs fail closed', () => {
  it.each([
    // Comments — including the documented sharpest residual: a missed
    // comment-prefixed session-wide reset can stale every cached name.
    '-- note\nDEALLOCATE ALL',
    '/* c */ DEALLOCATE ALL',
    'DEALLOCATE ALL -- note',
    'DEALLOCATE ALL /* c */',
    'DEALLOCATE/**/ALL',
    'DEALLOCATE /* c */ foo',
    // Multi-statement text and extra semicolons.
    'DEALLOCATE foo; DEALLOCATE bar',
    'SELECT 1; DEALLOCATE ALL',
    'DEALLOCATE ALL; SELECT 1',
    'DEALLOCATE foo;;',
    'DEALLOCATE ALL;;',
    // Unicode-escape identifier syntax stays out of scope.
    'DEALLOCATE U&"m"',
    `DEALLOCATE U&"d!0061t" UESCAPE '!'`,
    'DEALLOCATE u&"m"',
    // Unterminated and empty delimited identifiers.
    'DEALLOCATE "abc',
    'DEALLOCATE ""',
    'DEALLOCATE "a""', // the "" escapes — still unterminated
    'DEALLOCATE PREPARE "unterminated',
    // Invalid regular-identifier starts.
    'DEALLOCATE 9name',
    'DEALLOCATE $name',
    'DEALLOCATE $1',
    // Junk after a complete target.
    'DEALLOCATE foo bar',
    'DEALLOCATE ALL foo',
    'DEALLOCATE "a" b',
    'DEALLOCATE PREPARE ALL foo',
    // Genuinely missing target or missing required word separator (bare
    // DEALLOCATE PREPARE is deliberately NOT here — it targets prepare).
    'DEALLOCATE',
    'DEALLOCATE ',
    'DEALLOCATE ;',
    'DISCARDALL',
    // Quoted adjacency stays strictly at the `"` boundary — a regular token
    // or keyword welded onto DEALLOCATE is one identifier, not a command,
    // and comments / Unicode-escape syntax / trailing junk still fail closed.
    'DEALLOCATEfoo', // single regular token — not a command
    'DEALLOCATEPREPARE"foo"', // PREPARE welded onto DEALLOCATE
    'DEALLOCATE/*x*/"foo"', // block comment before the quote
    'DEALLOCATE--x\n"foo"', // line comment before the quote
    'DEALLOCATEU&"foo"', // Unicode-escape identifier syntax
    'DEALLOCATE""', // empty quoted target
    'DEALLOCATE"abc', // unterminated quoted target
    'DEALLOCATE"a""', // the "" escapes — still unterminated
    'DEALLOCATE"a-b" foo', // junk token after a complete quoted target
    'DEALLOCATE"a-b";;', // a second semicolon (multi-statement)
    'DEALLOCATE"a-b"; SELECT 1', // a second statement after the quoted target
    // Near-keywords and non-ASCII lookalikes inside keywords.
    'DEALLOCATEX foo',
    'DEALLOCATES ALL',
    'DÉALLOCATE foo', // DÉALLOCATE
    'DEALLOCATЕ ALL', // Cyrillic Е in the keyword
    'DISCARD ÀLL', // DISCARD accepts only ASCII ALL
    // Other DISCARD variants and arbitrary SQL.
    'DISCARD PLANS',
    'DISCARD TEMP',
    'DISCARD SEQUENCES',
    'DISCARD',
    'DISCARD ALL; SELECT 1', // a valid session reset hidden in multi-statement text
    'DISCARD ALL ALL',
    'SELECT 1',
    'INSERT INTO t (id) VALUES ($1)',
    'PREPARE foo AS SELECT 1',
    '',
    '   ',
    ';',
  ])('returns null for %j', (sql) => {
    expect(decodeStatementCacheInvalidation(sql)).toBeNull();
  });
});

// PGlite's own parse_ident(..., strict) is the authority on how the backend
// folds and unescapes one identifier: the decoder's { name } must equal the
// LAST element of parse_ident's array for the same spelling. Test oracle
// ONLY — production never runs a catalog query (plan, "Alternatives
// rejected"). Separate describe so the grammar tables above stay
// backend-free.
describe('decodeStatementCacheInvalidation — parse_ident oracle (real PGlite)', () => {
  it.each([
    'MÜNZE',
    'münze',
    '"a""b"',
    '"MiXeD"',
    '_x$1',
    '\u{20000}',
  ])('agrees with parse_ident for DEALLOCATE %j', async (spelling) => {
    const { rows } = await pglite.query<{ parts: unknown }>(
      'SELECT parse_ident($1, true) AS parts',
      [spelling],
    );
    const parts = rows[0]?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
      throw new Error(`parse_ident returned no identifiers for ${JSON.stringify(spelling)}`);
    }
    const backendName: unknown = parts[parts.length - 1];
    if (typeof backendName !== 'string') {
      throw new Error(`parse_ident returned a non-string part for ${JSON.stringify(spelling)}`);
    }
    expect(decodeStatementCacheInvalidation(`DEALLOCATE ${spelling}`)).toEqual({
      name: backendName,
    });
  });
});
