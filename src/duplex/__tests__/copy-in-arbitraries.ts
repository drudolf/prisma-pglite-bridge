/**
 * Generators, by-construction oracle, and PGlite split-check scenarios for
 * the copy-in sniffer property suite.
 * Spec: .claude/plans/copy-in-property-tests.md
 *
 * PG LEXER SEMANTICS ENCODED HERE (the oracle's ground truth, validated
 * against a live PGlite by the split-check in copy-in.property.test.ts):
 *
 * - Standard strings '…' (standard_conforming_strings=on): backslash has NO
 *   escape meaning; '' quote-doubling is the only escape. A quote preceded by
 *   any number of backslashes still closes the literal.
 * - E-strings E'…' / e'…': backslash escapes honored (\' \\ …) plus ''
 *   doubling. The E prefix opens an E-string ONLY at a word boundary: an e/E
 *   glued to a preceding identifier/keyword character belongs to that word —
 *   LIKE'\' is keyword LIKE + STANDARD string, xe'1' is a typed literal
 *   (type name xe + standard string). PGlite-confirmed: executing
 *   SELECT 'a' LIKE'\' raises the LIKE trailing-escape RUNTIME error, and
 *   SELECT xe'1' raises `type "xe" does not exist` — both prove the quote
 *   closed where standard-string rules say it does.
 * - Quoted identifiers "…": "" doubling; content (;, \, copy phrases) inert.
 * - Dollar quotes $tag$…$tag$: tag is [A-Za-z_][A-Za-z0-9_]* or empty,
 *   case-sensitive, closed by the leftmost later occurrence of the exact
 *   delimiter. Digits-only pseudo-tags ($1$) are NOT delimiters — $1 lexes
 *   as a positional parameter. A $ glued to a preceding identifier character
 *   extends that identifier (PG permits $ inside identifiers): a$tag$ is ONE
 *   identifier, not ident + quote. PGlite-confirmed via
 *   SELECT 1 AS a$tag$; COPY <missing> FROM STDIN reaching the COPY.
 * - Comments: -- runs to end of line; block comments NEST.
 * - Statement split: top-level ; separates. Empty statements (;;, leading ;,
 *   trailing ;) contribute NO statements.
 * - Parse-first: the raw parser lexes/parses the WHOLE text before executing
 *   anything. A text that fails to LEX (unterminated string/dollar quote,
 *   stray \ or $) executes nothing, so the forward-faithful verdict for such
 *   texts is 'not-copy-in' (PG reports its own error; no COPY can ever run).
 *   A text that lexes cleanly is judged by its lexical split even if a
 *   statement is grammatically invalid — the sniffer contract is lexical.
 *
 * Generator hygiene: outside the dedicated adjacency and dollar-glue arms,
 * every atom is separated from its neighbors by whitespace or punctuation,
 * plain identifier pools contain no 'e' and at most one interior '$', and
 * dollar-quote bodies are filtered so the leftmost closer is the final one —
 * so no random arm can accidentally reproduce the word-boundary shapes.
 */
import fc from 'fast-check';

import type { CopyInVerdict } from '../copy-in.ts';

type StatementArm = 'copy' | 'non-copy' | 'adjacency' | 'dollar-glue';

type BuiltStatement = {
  text: string;
  isCopyIn: boolean;
  arm: StatementArm;
};

export type ComposedScenario = {
  text: string;
  statementCount: number;
  copyInCount: number;
  arms: StatementArm[];
};

export const expectedVerdict = (scenario: ComposedScenario): CopyInVerdict => {
  if (scenario.copyInCount === 0) return 'not-copy-in';
  return scenario.statementCount === 1 ? 'capture' : 'reject-multi';
};

// --------------------------------------------------------------------------
// Atoms
// --------------------------------------------------------------------------

// No 'e' anywhere (structurally rules out accidental E-string adjacency) and
// no reserved words that could confuse the token scan.
const identHeadArb = fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z', '_');
const identTailArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'x', 'y', 'z', '0', '1', '_'),
  maxLength: 5,
});
const plainIdentArb: fc.Arbitrary<string> = fc
  .tuple(identHeadArb, identTailArb)
  .map(([head, tail]) => head + tail);

// Exactly one interior $, never trailing: a$b is one PG identifier and the
// scanner's $tag$ regex cannot match a lone $.
const dollarIdentArb: fc.Arbitrary<string> = fc
  .tuple(plainIdentArb, fc.constantFrom('a', 'b', 'x', '0', '1'))
  .map(([base, tail]) => `${base}$${tail}`);

const quotedIdentBodyArb = fc.oneof(
  fc.string({
    unit: fc.constantFrom('a', 'x', ';', ' ', '{', '}', "'", '$', '\\', '-', '*', '"'),
    maxLength: 8,
  }),
  fc.constantFrom('copy t from stdin', 'a;b', "it's", 'we"ird'),
);
const quotedIdentArb: fc.Arbitrary<string> = quotedIdentBodyArb.map(
  (body) => `"${body.replaceAll('"', '""')}"`,
);

const stdStringBodyArb = fc.oneof(
  fc.string({
    unit: fc.constantFrom('a', 'b', ' ', ';', '$', '-', '/', '*', '\\', "'", 'x'),
    maxLength: 8,
  }),
  fc.constantFrom('copy t from stdin', 'a;b', '', '\\', "it's"),
  // Odd trailing backslash runs — safe in standard strings at a word
  // boundary; only the glued-E adjacency arm makes them dangerous.
  fc
    .tuple(fc.string({ unit: fc.constantFrom('a', ';', ' '), maxLength: 4 }), fc.constantFrom(1, 3))
    .map(([body, run]) => body + '\\'.repeat(run)),
);
const stdStringArb: fc.Arbitrary<string> = stdStringBodyArb.map(
  (body) => `'${body.replaceAll("'", "''")}'`,
);

// Rendered with proper E-string escapes, so PG and any escape-honoring
// scanner close at the same quote.
const eStringArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom('E', 'e'), stdStringBodyArb)
  .map(([prefix, body]) => `${prefix}'${body.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`);

const dollarTagArb = fc.oneof(
  fc.constant(''),
  fc
    .tuple(
      fc.constantFrom('t', 'q', '_', 'tag', 'body'),
      fc.string({ unit: fc.constantFrom('a', 'g', '1', '_'), maxLength: 3 }),
    )
    .map(([head, tail]) => head + tail),
);
const dollarBodyArb = fc.oneof(
  fc.string({
    unit: fc.constantFrom('a', ' ', ';', "'", '\\', '-', '/', '*', '$', 'x', '\n'),
    maxLength: 10,
  }),
  fc.constantFrom('copy t from stdin', "$inner$ ' ; $inner$", '$$', "'; COPY t FROM STDIN"),
);
const dollarQuoteArb: fc.Arbitrary<string> = fc
  .tuple(dollarTagArb, dollarBodyArb)
  .map(([tag, body]) => ({ closer: `$${tag}$`, rendered: `$${tag}$${body}$${tag}$` }))
  .filter(
    // The leftmost closer occurrence must be the final one, so PG's forward
    // scan and the ground truth agree on where the literal ends.
    ({ closer, rendered }) =>
      rendered.indexOf(closer, closer.length) === rendered.length - closer.length,
  )
  .map(({ rendered }) => rendered);

const lineCommentArb: fc.Arbitrary<string> = fc
  .string({ unit: fc.constantFrom('a', ' ', ';', "'", '$', 'c', '-'), maxLength: 8 })
  .map((body) => `--${body}\n`);

const blockCommentTextArb = fc.string({
  unit: fc.constantFrom('a', ' ', ';', "'", '$', 'x', '-', '\n'),
  maxLength: 6,
});
const blockCommentArb: fc.Arbitrary<string> = fc
  .tuple(blockCommentTextArb, fc.option(blockCommentTextArb), blockCommentTextArb)
  .map(([before, nested, after]) =>
    nested === null ? `/*${before}*/` : `/*${before}/*${nested}*/${after}*/`,
  );

const whitespaceArb = fc.constantFrom(' ', '  ', '\n', '\t', '\n  ');

/** Token separator: whitespace, optionally carrying a comment. */
export const triviaArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: whitespaceArb, weight: 4 },
  { arbitrary: fc.tuple(whitespaceArb, blockCommentArb).map(([ws, c]) => `${ws}${c} `), weight: 1 },
  { arbitrary: fc.tuple(whitespaceArb, lineCommentArb).map(([ws, c]) => `${ws}${c}`), weight: 1 },
);

const casedKeywordArb = (word: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: word.length, maxLength: word.length }).map((flags) =>
    word
      .split('')
      .map((ch, i) => (flags[i] === true ? ch.toUpperCase() : ch))
      .join(''),
  );

// --------------------------------------------------------------------------
// Statement builders
// --------------------------------------------------------------------------

const copyTargetArb: fc.Arbitrary<string> = fc.oneof(
  plainIdentArb,
  quotedIdentArb,
  dollarIdentArb,
  fc.tuple(plainIdentArb, plainIdentArb).map(([schema, table]) => `${schema}.${table}`),
);

const columnListArb: fc.Arbitrary<string> = fc
  .array(fc.oneof(plainIdentArb, quotedIdentArb), { minLength: 1, maxLength: 3 })
  .map((columns) => `(${columns.join(', ')})`);

// Lexically valid options only; quoted ; and E-string delimiters stress the
// scanner's quote handling inside the option list.
const copyOptionsArb: fc.Arbitrary<string> = fc.constantFrom(
  ' WITH (FORMAT csv)',
  ' WITH (FORMAT csv, HEADER)',
  " WITH (FORMAT csv, DELIMITER ';')",
  " WITH (DELIMITER E'\\t')",
  " WITH (FORMAT csv, QUOTE '''')",
  " WITH (NULL '\\N')",
  ' (FREEZE)',
  " with (format csv, delimiter ';')",
);

const copyStatementArb = (targetArb: fc.Arbitrary<string>): fc.Arbitrary<BuiltStatement> =>
  fc
    .record({
      kwCopy: casedKeywordArb('copy'),
      sep1: triviaArb,
      target: targetArb,
      columns: fc.option(columnListArb),
      sep2: triviaArb,
      kwFrom: casedKeywordArb('from'),
      sep3: triviaArb,
      kwStdin: casedKeywordArb('stdin'),
      options: fc.option(copyOptionsArb),
    })
    .map(
      ({
        kwCopy,
        sep1,
        target,
        columns,
        sep2,
        kwFrom,
        sep3,
        kwStdin,
        options,
      }): BuiltStatement => ({
        text: `${kwCopy}${sep1}${target}${columns === null ? '' : ` ${columns}`}${sep2}${kwFrom}${sep3}${kwStdin}${options ?? ''}`,
        isCopyIn: true,
        arm: 'copy',
      }),
    );

const COPY_PHRASE = 'COPY t FROM STDIN';

// The literal copy-in phrase embedded in every quoting construct.
const embeddedPhraseAtomArb: fc.Arbitrary<string> = fc.constantFrom(
  `'${COPY_PHRASE}'`,
  `E'${COPY_PHRASE}'`,
  `$x$${COPY_PHRASE}$x$`,
  `$$${COPY_PHRASE}$$`,
  `"${COPY_PHRASE}"`,
);

const exprAtomArb: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: stdStringArb, weight: 3 },
  { arbitrary: eStringArb, weight: 2 },
  { arbitrary: dollarQuoteArb, weight: 2 },
  { arbitrary: plainIdentArb, weight: 2 },
  { arbitrary: quotedIdentArb, weight: 1 },
  { arbitrary: dollarIdentArb, weight: 1 },
  { arbitrary: embeddedPhraseAtomArb, weight: 2 },
  { arbitrary: fc.constantFrom('1', '42'), weight: 1 },
);

const nonCopyStatementArb: fc.Arbitrary<BuiltStatement> = fc
  .oneof(
    fc
      .record({
        kw: casedKeywordArb('select'),
        sep: triviaArb,
        atoms: fc.array(exprAtomArb, { minLength: 1, maxLength: 3 }),
      })
      .map(({ kw, sep, atoms }) => `${kw}${sep}${atoms.join(', ')}`),
    fc
      .record({ table: plainIdentArb, atom: exprAtomArb })
      .map(({ table, atom }) => `INSERT INTO ${table} VALUES (${atom})`),
    fc
      .record({ table: plainIdentArb, column: plainIdentArb, atom: exprAtomArb })
      .map(({ table, column, atom }) => `UPDATE ${table} SET ${column} = ${atom}`),
    fc
      .record({
        kwCopy: casedKeywordArb('copy'),
        target: copyTargetArb,
        options: fc.option(fc.constantFrom(" WITH (DELIMITER ';')", ' WITH (FORMAT csv)')),
      })
      .map(({ kwCopy, target, options }) => `${kwCopy} ${target} TO STDOUT${options ?? ''}`),
    // Quoted 'stdin' is a file path, not the STDIN keyword.
    fc.record({ target: plainIdentArb }).map(({ target }) => `COPY ${target} FROM 'stdin'`),
    fc.constantFrom(`SELECT /*${COPY_PHRASE}*/ 1`, `SELECT --${COPY_PHRASE}\n1`),
  )
  .map((text): BuiltStatement => ({ text, isCopyIn: false, arm: 'non-copy' }));

// Adjacency arm (confirmed divergence class): a word ending in e/E glued to a
// standard string whose body carries a trailing backslash run. PG lexes
// word + STANDARD string (typed-literal / keyword grammar); every statement
// here is a complete single statement under PG.
const adjacencyStatementArb: fc.Arbitrary<BuiltStatement> = fc
  .oneof(
    fc
      .record({
        word: fc.constantFrom('xe', 'a0e', 'x_e', 'a$e', 'note', 'tre', 'date', 'xE', 'simulatE'),
        body: fc.constantFrom('', 'a', 'ab'),
        run: fc.constantFrom(1, 2, 3),
      })
      .map(({ word, body, run }) => `SELECT ${word}'${body}${'\\'.repeat(run)}'`),
    fc
      .record({ body: fc.constantFrom('', 'a'), run: fc.constantFrom(1, 3) })
      .map(({ body, run }) => `SELECT 'a' LIKE'${body}${'\\'.repeat(run)}'`),
    fc.record({ run: fc.constantFrom(1, 3) }).map(({ run }) => {
      const literal = `'a${'\\'.repeat(run)}'`;
      return `SELECT CASE${literal} WHEN ${literal} THEN 1 ELSE 2 END`;
    }),
  )
  .map((text): BuiltStatement => ({ text, isCopyIn: false, arm: 'adjacency' }));

// Dollar-glue arm (confirmed divergence class): $tag$ glued to an identifier.
// PG reads the whole run as ONE identifier; every statement is a complete,
// even succeeding, single statement (SELECT 1 AS <ident>).
const dollarGlueStatementArb: fc.Arbitrary<BuiltStatement> = fc
  .record({
    base: fc.constantFrom('a', 'b0', 'x_', 'w'),
    extraDollar: fc.boolean(),
    tag: fc.constantFrom('tag', 'q', 't1', '_t', ''),
    suffix: fc.constantFrom('', 'x', 'x1'),
    closed: fc.boolean(),
  })
  .map(({ base, extraDollar, tag, suffix, closed }): BuiltStatement => {
    const delim = `$${tag}$`;
    const alias = `${base}${extraDollar ? '$' : ''}${delim}${suffix}${closed ? delim : ''}`;
    return { text: `SELECT 1 AS ${alias}`, isCopyIn: false, arm: 'dollar-glue' };
  });

// --------------------------------------------------------------------------
// Text composer
// --------------------------------------------------------------------------

const statementArb: fc.Arbitrary<BuiltStatement> = fc.oneof(
  { arbitrary: copyStatementArb(copyTargetArb), weight: 3 },
  { arbitrary: nonCopyStatementArb, weight: 3 },
  { arbitrary: adjacencyStatementArb, weight: 2 },
  { arbitrary: dollarGlueStatementArb, weight: 2 },
);

// Leading ;, ;;-doubled separators, and trailing ;/;; contribute NO
// statements (PG empty-statement rule), so the counts ignore them.
const leadingArb = fc.constantFrom('', ';', '; ', '\n');
const separatorArb = fc.constantFrom(';', ';;', '; ', ' ;\n', ';;\n', ';\t');
const trailingArb = fc.constantFrom('', ';', ';;', '; --done\n', ';\n', ' ');

const compose = (
  lead: string,
  stmts: readonly BuiltStatement[],
  seps: readonly string[],
  trail: string,
): ComposedScenario => {
  const parts: string[] = [lead];
  stmts.forEach((stmt, i) => {
    parts.push(stmt.text);
    if (i < stmts.length - 1) parts.push(seps[i] ?? ';');
  });
  parts.push(trail);
  return {
    text: parts.join(''),
    statementCount: stmts.length,
    copyInCount: stmts.filter((stmt) => stmt.isCopyIn).length,
    arms: stmts.map((stmt) => stmt.arm),
  };
};

const composerRecordArb = (
  stmtsArb: fc.Arbitrary<BuiltStatement[]>,
): fc.Arbitrary<ComposedScenario> =>
  fc
    .record({
      lead: leadingArb,
      stmts: stmtsArb,
      seps: fc.array(separatorArb, { minLength: 3, maxLength: 3 }),
      trail: trailingArb,
    })
    .map(({ lead, stmts, seps, trail }) => compose(lead, stmts, seps, trail));

const randomComposedArb = composerRecordArb(fc.array(statementArb, { minLength: 1, maxLength: 4 }));

// Biased arm forcing "copy-in present alongside other statements" (P1's
// subject) to co-occur within the run budget.
const biasedMultiArb = composerRecordArb(
  fc
    .tuple(
      copyStatementArb(copyTargetArb),
      fc.array(statementArb, { minLength: 1, maxLength: 2 }),
      fc.nat(),
    )
    .map(([copy, others, positionSeed]) => {
      const stmts = [...others];
      stmts.splice(positionSeed % (others.length + 1), 0, copy);
      return stmts;
    }),
);

// Single copy statement with the explicit COPY…;; / ;COPY… edge shapes.
const copySoloArb = composerRecordArb(copyStatementArb(copyTargetArb).map((stmt) => [stmt]));

export const composedScenarioArb: fc.Arbitrary<ComposedScenario> = fc.oneof(
  { arbitrary: randomComposedArb, weight: 4 },
  { arbitrary: biasedMultiArb, weight: 3 },
  { arbitrary: copySoloArb, weight: 2 },
);

/** Single-statement true copy-in text (P3's 'capture' base). */
export const copyCaptureTextArb: fc.Arbitrary<string> = copyStatementArb(copyTargetArb).map(
  (stmt) => stmt.text,
);

/** Single non-copy statement text (P3's reject-multi append). */
export const nonCopyTextArb: fc.Arbitrary<string> = nonCopyStatementArb.map((stmt) => stmt.text);

// --------------------------------------------------------------------------
// PGlite split-check scenarios
// --------------------------------------------------------------------------

/** Guaranteed-missing relation: nothing in the suite ever creates it, so a
 * reached copy-in fails at ANALYSIS ("relation … does not exist") and never
 * enters copy mode. */
export const SENTINEL = 'copy_in_sniffer_missing_sentinel';

type SplitExpectation =
  | { kind: 'copy-analysis-error' }
  | { kind: 'all-succeed'; statementCount: number }
  | { kind: 'first-statement-error'; pattern: RegExp };

export type SplitScenario = { label: string; text: string; expected: SplitExpectation };

const SENT_COPY = `COPY ${SENTINEL} FROM STDIN`;

// Statements guaranteed to succeed (side-effect-free SELECTs), so PG
// proceeds past them to a following copy-in.
const succeedingSelectArb: fc.Arbitrary<BuiltStatement> = fc
  .oneof(
    fc.constant('SELECT 1'),
    stdStringArb.map((literal) => `SELECT ${literal}`),
    eStringArb.map((literal) => `SELECT ${literal}`),
    dollarQuoteArb.map((literal) => `SELECT ${literal}`),
    blockCommentArb.map((comment) => `SELECT ${comment} 1`),
    lineCommentArb.map((comment) => `SELECT ${comment}1`),
    fc.constantFrom('SELECT 1 AS "a;b"', "SELECT 'it''s'", "SELECT E'\\''"),
  )
  .map((text): BuiltStatement => ({ text, isCopyIn: false, arm: 'non-copy' }));

const splitComposedArb: fc.Arbitrary<ComposedScenario> = composerRecordArb(
  fc.array(
    fc.oneof(
      { arbitrary: succeedingSelectArb, weight: 3 },
      { arbitrary: copyStatementArb(fc.constant(SENTINEL)), weight: 2 },
    ),
    { minLength: 1, maxLength: 3 },
  ),
);

const HAND_WRITTEN_SPLIT_SCENARIOS: SplitScenario[] = [
  {
    label: 'probe: LIKE-glued standard string closes, ; splits (LIKE runtime error is the proof)',
    text: `SELECT 'a' LIKE'\\'; ${SENT_COPY}`,
    expected: {
      kind: 'first-statement-error',
      pattern: /LIKE pattern must not end with escape character/,
    },
  },
  {
    label: 'probe: CASE-glued standard strings succeed and PG reaches the swallowed copy-in',
    text: `SELECT CASE'a\\' WHEN 'a\\' THEN 1 ELSE 2 END; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: a$tag$ is one identifier — the alias succeeds and PG reaches the copy-in',
    text: `SELECT 1 AS a$tag$; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: a$tag$x (unclosed shape) is one identifier',
    text: `SELECT 1 AS a$tag$x; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: a$$x (empty pseudo-tag glued) is one identifier',
    text: `SELECT 1 AS a$$x; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: a$$tag$x$tag$ ($-glued, closed shape) is one identifier',
    text: `SELECT 1 AS a$$tag$x$tag$; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: a$1$x (digits-only pseudo-tag glued) is one identifier',
    text: `SELECT 1 AS a$1$x; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: letter-glued xe is a typed literal (analysis error names the type)',
    text: `SELECT xe'1'; ${SENT_COPY}`,
    expected: { kind: 'first-statement-error', pattern: /type "xe" does not exist/ },
  },
  {
    label: 'probe: digit-glued a0e is a typed literal',
    text: `SELECT a0e'1'; ${SENT_COPY}`,
    expected: { kind: 'first-statement-error', pattern: /type "a0e" does not exist/ },
  },
  {
    label: 'probe: underscore-glued x_e is a typed literal',
    text: `SELECT x_e'1'; ${SENT_COPY}`,
    expected: { kind: 'first-statement-error', pattern: /type "x_e" does not exist/ },
  },
  {
    label: 'probe: dollar-glued a$e is a typed literal',
    text: `SELECT a$e'1'; ${SENT_COPY}`,
    expected: { kind: 'first-statement-error', pattern: /type "a\$e" does not exist/ },
  },
  {
    // High-bit char glued before $tag$ (ä ≥ 0x80, PG ident_cont): aä$tag$ is
    // ONE identifier, so the alias succeeds and PG reaches the copy-in — the
    // fail-open shape the word-boundary fix closes. Pre-fix the scanner opened
    // a fake dollar quote on $tag$ and swallowed the tail (not-copy-in).
    label: 'probe: high-bit-glued aä$tag$ is one identifier and PG reaches the copy-in',
    text: `SELECT 1 AS aä$tag$; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    // High-bit char glued before e' (ä ≥ 0x80): aäe is a type name, 'x' a
    // standard string — a typed literal; the ; splits.
    label: 'probe: high-bit-glued aäe is a typed literal (analysis error names the type)',
    text: `SELECT aäe'x'; ${SENT_COPY}`,
    expected: { kind: 'first-statement-error', pattern: /type "aäe" does not exist/ },
  },
  {
    label: 'probe: boundary E-string honors backslash escapes and PG reaches the copy-in',
    text: `SELECT E'a\\''; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: boundary standard string ignores a trailing backslash and closes',
    text: `SELECT 'a\\'; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'probe: $1$x$1$ is param + $x$ dollar-quote opener (unterminated)',
    text: 'SELECT $1$x$1$',
    expected: { kind: 'first-statement-error', pattern: /unterminated dollar-quoted string/ },
  },
  {
    label: 'probe: $1$x is param + stray $ (lexer rejects the whole text)',
    text: 'SELECT $1$x',
    expected: { kind: 'first-statement-error', pattern: /syntax error at or near "\$"/ },
  },
  {
    label:
      'probe: a bare E-string statement lexes but fails PG grammar (parse-first: no COPY runs)',
    text: `E'x'; ${SENT_COPY}`,
    expected: { kind: 'first-statement-error', pattern: /syntax error at or near "E'x'"/ },
  },
  {
    label: 'quoted identifier hides a semicolon',
    text: `SELECT 1 AS "a;b"; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'doubled quote escape hides the copy phrase',
    text: `SELECT 'it''s; COPY t FROM STDIN'; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'copy-in options hide a quoted semicolon',
    text: `${SENT_COPY} WITH (FORMAT csv, DELIMITER ';')`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'nested block comment before the copy-in',
    text: `SELECT /* a /* b */ c */ 1; ${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'line comment before the copy-in',
    text: `--load\n${SENT_COPY}`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'copy-in mid-text after a succeeding statement',
    text: `SELECT 1; ${SENT_COPY}; SELECT 2`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'bare sentinel copy-in (single statement)',
    text: SENT_COPY,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: 'trailing ;; after the copy-in',
    text: `${SENT_COPY};;`,
    expected: { kind: 'copy-analysis-error' },
  },
  {
    label: ';;-doubled separator contributes no statement',
    text: 'SELECT 1;;SELECT 2',
    expected: { kind: 'all-succeed', statementCount: 2 },
  },
  {
    label: 'leading and trailing ; contribute no statements',
    text: ';SELECT 1;',
    expected: { kind: 'all-succeed', statementCount: 1 },
  },
  {
    label: 'semicolons-only text has no statements',
    text: '  ;;  ',
    expected: { kind: 'all-succeed', statementCount: 0 },
  },
  {
    label: 'dollar-quoted copy phrase is inert',
    text: `SELECT $q$ '\\ ; COPY t FROM STDIN $q$`,
    expected: { kind: 'all-succeed', statementCount: 1 },
  },
];

/**
 * Deterministic split-check sample: hand-written lexer-claim probes plus a
 * fixed-seed sample of composed texts whose non-copy statements all succeed.
 */
export const splitCheckScenarios = (): SplitScenario[] => {
  const sampled = fc
    .sample(splitComposedArb, { seed: 20260726, numRuns: 14 })
    .map((scenario, index): SplitScenario => {
      const preview = scenario.text.replace(/\s+/g, ' ').slice(0, 60);
      return {
        label: `sampled #${index}: ${preview}`,
        text: scenario.text,
        expected:
          scenario.copyInCount === 0
            ? { kind: 'all-succeed', statementCount: scenario.statementCount }
            : { kind: 'copy-analysis-error' },
      };
    });
  return [...HAND_WRITTEN_SPLIT_SCENARIOS, ...sampled];
};
