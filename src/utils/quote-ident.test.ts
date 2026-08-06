import { describe, expect, it } from 'vitest';

import { quoteIdent } from './quote-ident.ts';

describe('quoteIdent', () => {
  it('wraps a plain identifier in double quotes', () => {
    expect(quoteIdent('users')).toBe('"users"');
  });

  it('doubles an embedded double quote (the quote_ident escape)', () => {
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it('doubles EVERY embedded quote, not just the first (global replace)', () => {
    expect(quoteIdent('a"b"c')).toBe('"a""b""c"');
  });

  it('quotes an empty identifier', () => {
    expect(quoteIdent('')).toBe('""');
  });

  it('escapes an identifier that is a single double quote', () => {
    expect(quoteIdent('"')).toBe('""""');
  });
});
