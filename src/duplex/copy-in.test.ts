// Quote-aware sniffer for simple-protocol Query text. Classifies a statement
// as a capturable `COPY ... FROM STDIN` ('capture'), a multi-statement
// `COPY ... FROM STDIN` that cannot be captured and must be rejected
// ('reject-multi'), or anything else ('not-copy-in' — forwarded unchanged).
// Forwarding a COPY-FROM-STDIN kills the PGlite instance (WASM exit(1)), so
// any misclassification toward 'not-copy-in' is instance death: every case
// below is a wire-safety contract.
import { describe, expect, it } from 'vitest';

import { sniffCopyIn } from './copy-in.ts';

describe('sniffCopyIn', () => {
  describe('classifies a single-statement COPY ... FROM STDIN as capture', () => {
    it.each([
      ['a bare statement', 'COPY t FROM STDIN'],
      ['a trailing semicolon', 'COPY t FROM STDIN;'],
      ['a trailing semicolon followed by whitespace', 'COPY t FROM STDIN;\n'],
      ['a schema-qualified table with a column list', 'COPY s.t (a, b) FROM STDIN'],
      ['WITH options', 'COPY t FROM STDIN WITH (FORMAT csv, HEADER)'],
      [
        'a semicolon inside a quoted option value',
        "COPY t FROM STDIN WITH (FORMAT csv, DELIMITER ';')",
      ],
      ['lowercase keywords', 'copy t from stdin'],
      ['leading whitespace and newlines', '  \n\t COPY t FROM STDIN'],
      ['a leading line comment', '-- load\nCOPY t FROM STDIN'],
      ['a leading block comment', '/* x */ COPY t FROM STDIN'],
      ['a NESTED block comment (PG nests them)', '/* a /* b */ c */ COPY t FROM STDIN'],
      ['the bare parenthesized option form', 'COPY t FROM STDIN (FREEZE)'],
      ['a doubled quote inside a quoted identifier', 'COPY "we""ird" FROM STDIN'],
      [
        "a doubled '' escape inside an option literal",
        "COPY t FROM STDIN WITH (DELIMITER ''';''')",
      ],
      ['an E-string option with backslash escapes', "COPY t FROM STDIN WITH (DELIMITER E'\\t')"],
    ])('%s: %j', (_label, text) => {
      expect(sniffCopyIn(text)).toBe('capture');
    });
  });

  describe('classifies anything that is not COPY ... FROM STDIN as not-copy-in', () => {
    it.each([
      ['a plain SELECT', 'SELECT 1'],
      ['COPY ... TO STDOUT', 'COPY t TO STDOUT'],
      ["a quoted 'stdin' file path", "COPY t FROM 'stdin'"],
      ['a quoted "stdin" identifier (invalid SQL — the backend rejects it)', 'COPY t FROM "stdin"'],
      [
        'COPY ... TO STDOUT with a quoted semicolon option',
        "COPY t TO STDOUT WITH (DELIMITER ';')",
      ],
      ['text mentioning stdin without a leading COPY', 'SELECT stdin FROM copy_jobs'],
      [
        'the phrase inside a single-quoted string literal',
        "INSERT INTO copy_log VALUES ('COPY t FROM STDIN')",
      ],
      ["the phrase behind an '' escape inside a literal", "SELECT 'it''s not: COPY t FROM STDIN'"],
      ['the phrase inside an E-string with escaped quotes', "SELECT E'\\' COPY t FROM STDIN'"],
      ['the phrase inside a dollar-quoted body', 'SELECT $$COPY t FROM STDIN$$'],
      ['a positional parameter (a $ that opens no dollar quote)', 'SELECT $1 + 1'],
      ['an unterminated dollar quote swallowing the phrase', 'SELECT $$COPY t FROM STDIN'],
      ['a statement with no word tokens at all', '42'],
    ])('%s: %j', (_label, text) => {
      expect(sniffCopyIn(text)).toBe('not-copy-in');
    });
  });

  describe('classifies a multi-statement COPY ... FROM STDIN as reject-multi (fail closed)', () => {
    it.each([
      ['a second statement after the COPY', 'COPY t FROM STDIN; SELECT 1'],
      [
        'a quoted semicolon before the real statement separator',
        "COPY t FROM STDIN WITH (DELIMITER ';'); SELECT 1",
      ],
      // Word-boundary regressions: PG lexes the first statement's quote/tag
      // as ending at the word boundary, so the ; is a real separator and the
      // trailing COPY is a second statement. The scanner used to swallow the
      // tail (verdict not-copy-in = instance death). See the characterization
      // table in copy-in.property.test.ts for the full grid.
      [
        "an E-string opener glued to a keyword (LIKE'\\')",
        "SELECT 'a' LIKE'\\'; COPY t FROM STDIN",
      ],
      ['a $ inside a preceding identifier (a$tag$)', 'SELECT 1 AS a$tag$; COPY t FROM STDIN'],
      ['a literal-only leading statement', "E'x'; COPY t FROM STDIN"],
      ['a quoted-identifier-only leading statement', '"foo"; COPY t FROM STDIN'],
    ])('%s: %j', (_label, text) => {
      expect(sniffCopyIn(text)).toBe('reject-multi');
    });
  });

  describe('word-boundary guards that must keep their prior verdict', () => {
    it.each([
      [
        'a free-standing E-string option is still stripped',
        "COPY t FROM STDIN WITH (DELIMITER E'\\t')",
        'capture',
      ],
      [
        'a dollar-quoted body still hides the phrase',
        'SELECT $$COPY t FROM STDIN$$',
        'not-copy-in',
      ],
      [
        'a bare parameter opens no dollar quote',
        'SELECT $1$x COPY t FROM STDIN $1$x',
        'not-copy-in',
      ],
    ] as const)('%s: %j', (_label, text, expected) => {
      expect(sniffCopyIn(text)).toBe(expected);
    });
  });
});

describe('mutation-hardening: survivor kills', () => {
  it('a high-bit (U+0080) char glued before $tag$ keeps the identifier and splits the ; (reject-multi)', () => {
    expect(sniffCopyIn('SELECT 1 AS a\u0080$tag$; COPY t FROM STDIN')).toBe('reject-multi');
  });

  it('a lone hyphen is not a line comment: the following COPY still counts (reject-multi)', () => {
    expect(sniffCopyIn('SELECT 1-1; COPY t FROM STDIN')).toBe('reject-multi');
  });

  it('a line comment with no trailing newline still terminates (not-copy-in)', () => {
    expect(sniffCopyIn('-- COPY t FROM STDIN')).toBe('not-copy-in');
  }, 2000);

  it('a lone slash is not a block-comment opener: the following COPY still counts (reject-multi)', () => {
    expect(sniffCopyIn('SELECT 1/2; COPY t FROM STDIN')).toBe('reject-multi');
  });

  it('an unterminated block comment still terminates (not-copy-in)', () => {
    expect(sniffCopyIn('/* COPY t FROM STDIN')).toBe('not-copy-in');
  }, 2000);

  it('a stray slash inside a block comment does not over-nest and swallow the COPY (capture)', () => {
    expect(sniffCopyIn('/* /; */ COPY t FROM STDIN')).toBe('capture');
  });

  it('a stray asterisk inside a block comment does not close it early (capture)', () => {
    expect(sniffCopyIn('/* a * b */ COPY t FROM STDIN')).toBe('capture');
  });

  it('a block comment is replaced by a space so it cannot glue tokens into COPY (not-copy-in)', () => {
    expect(sniffCopyIn('COP/* */Y t FROM STDIN')).toBe('not-copy-in');
  });

  it('scanning resumes AFTER a dollar-quote closer, so the trailing COPY still counts (reject-multi)', () => {
    expect(sniffCopyIn('SELECT $$;$$; COPY t FROM STDIN')).toBe('reject-multi');
  });

  it('COPY t FROM foo (a relation/file, no STDIN) is not copy-in', () => {
    expect(sniffCopyIn('COPY t FROM foo')).toBe('not-copy-in');
  });

  it('COPY t x STDIN (stdin not preceded by FROM) is not copy-in', () => {
    expect(sniffCopyIn('COPY t x STDIN')).toBe('not-copy-in');
  });

  it('COPY t FROM bar (from not followed by stdin) is not copy-in', () => {
    expect(sniffCopyIn('COPY t FROM bar')).toBe('not-copy-in');
  });
});
