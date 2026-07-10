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
    ])('%s: %j', (_label, text) => {
      expect(sniffCopyIn(text)).toBe('reject-multi');
    });
  });
});
