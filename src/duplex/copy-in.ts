/**
 * Quote-aware classifier for simple-protocol Query text: is this a
 * `COPY ... FROM STDIN` the duplex must capture?
 *
 * Forwarding a copy-in query to PGlite kills the WASM instance — the
 * backend's synchronous copy-read loop treats an exhausted input buffer
 * as connection EOF and calls exit(1) — so misclassifying toward
 * "forward" is instance death. The scanner therefore errs closed: a
 * multi-statement text containing a copy-in statement ANYWHERE is
 * 'reject-multi' (the duplex answers it with a synthesized error and
 * never lets PGlite see it), even in orderings that might assemble
 * correctly.
 *
 * A regex is not enough (tribunal 2026-07-10): `WITH (FORMAT csv,
 * DELIMITER ';')` puts a semicolon inside quotes, and string literals /
 * dollar-quotes / comments can contain the phrase `COPY ... FROM STDIN`
 * without meaning it. The scan strips quoted regions and comments
 * first, then tokenizes.
 *
 * @internal
 */

/**
 * Replace string literals ('…' with '' escapes and E'…' backslash
 * escapes), quoted identifiers ("…"), dollar-quoted bodies
 * ($tag$…$tag$), line comments (-- …) and nested block comments with
 * spaces, so tokenization sees only structural SQL.
 */
const stripQuotedAndComments = (text: string): string => {
  const out: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    const next = i + 1 < n ? (text[i + 1] as string) : '';

    if (ch === '-' && next === '-') {
      while (i < n && text[i] !== '\n') i++;
      out.push(' ');
      continue;
    }
    if (ch === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      out.push(' ');
      continue;
    }
    if (ch === "'" || ((ch === 'e' || ch === 'E') && next === "'")) {
      const escaping = ch !== "'"; // E'…' honors backslash escapes
      i += escaping ? 2 : 1;
      while (i < n) {
        if (escaping && text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          // '' is an escaped quote inside the literal, not the end.
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push(' ');
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out.push(' ');
      continue;
    }
    if (ch === '$') {
      // Dollar quote: $tag$ … $tag$ where tag is [A-Za-z_][A-Za-z0-9_]* or empty.
      const tagMatch = /^\$[A-Za-z_]?[A-Za-z0-9_]*\$/.exec(text.slice(i));
      if (tagMatch) {
        const closer = tagMatch[0];
        const end = text.indexOf(closer, i + closer.length);
        i = end === -1 ? n : end + closer.length;
        out.push(' ');
        continue;
      }
    }
    out.push(ch);
    i++;
  }
  return out.join('');
};

/** Word tokens of one (already stripped) statement, lowercased. */
const tokenize = (statement: string): string[] =>
  statement.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? [];

/** First token COPY, with a top-level `FROM STDIN` keyword pair. */
const isCopyInStatement = (statement: string): boolean => {
  const tokens = tokenize(statement);
  if (tokens[0] !== 'copy') return false;
  for (let i = 1; i < tokens.length - 1; i++) {
    if (tokens[i] === 'from' && tokens[i + 1] === 'stdin') return true;
  }
  return false;
};

export type CopyInVerdict = 'capture' | 'reject-multi' | 'not-copy-in';

export const sniffCopyIn = (text: string): CopyInVerdict => {
  const stripped = stripQuotedAndComments(text);
  const statements = stripped
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (!statements.some(isCopyInStatement)) return 'not-copy-in';
  return statements.length === 1 ? 'capture' : 'reject-multi';
};
