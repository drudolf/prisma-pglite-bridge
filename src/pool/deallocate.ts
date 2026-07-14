/**
 * Bounded decoder for the statement-cache invalidation commands the bridge
 * intercepts: `DEALLOCATE [PREPARE] <name>`, `DEALLOCATE [PREPARE] ALL`, and
 * `DISCARD ALL` (design: .claude/plans/bounded-deallocate-identifier-decoder.md).
 *
 * Recognized grammar — deliberately bounded, everything else fails CLOSED
 * (returns null, no cache mutation; the SQL still runs unchanged):
 *
 *   ws         := ASCII space, tab, LF, CR, FF, VT
 *   quoted_sep := ws+ | empty only when the next token starts with '"'
 *   trailer    := ws* (";" ws*)? EOF
 *   command    := ws* DISCARD ws+ ALL trailer
 *               | ws* DEALLOCATE quoted_sep (PREPARE quoted_sep)? target trailer
 *   target     := ALL | regular_identifier | delimited_identifier
 *
 * Keywords compare case-insensitively for ASCII letters ONLY and must end on
 * a token boundary (`DEALLOCATEX` is an identifier, not a command). There is
 * no `/i` regex and no whole-string `.toLowerCase()` anywhere: JavaScript's
 * Unicode folding is NOT PostgreSQL identifier folding — `MÜNZE` folds to
 * `münze` in JS but to `mÜnze` in PGlite's UTF-8 scanner (ASCII-only
 * downcase), and confusing the two would evict a DISTINCT live statement.
 *
 * Regular identifiers follow PostgreSQL's UTF-8 scanner: first code unit
 * ASCII letter, `_`, or any unit >= 0x80 (surrogate halves included, so
 * supplementary-plane characters work pair-wise); continuation adds ASCII
 * digits and `$`. Only ASCII `A-Z` are folded (+0x20); every other code unit
 * is preserved exactly — no Unicode normalization. Delimited identifiers
 * decode `""` to one literal `"` and keep everything else verbatim
 * (whitespace, semicolons, comment-like text, case, non-ASCII); empty or
 * unterminated quotes reject.
 *
 * The separator between a command word and its target is normally
 * whitespace, but a delimited identifier may sit immediately adjacent: a `"`
 * opens a quoted identifier and cannot continue the preceding keyword, so
 * `DEALLOCATE"x"` and `DEALLOCATE PREPARE"x"` are unambiguous commands. A
 * regular identifier still requires whitespace — `DEALLOCATEx` is one token.
 *
 * The optional `PREPARE` is consumed as a keyword only when a complete
 * target and trailer follow — otherwise it IS the target: bare
 * `DEALLOCATE PREPARE` validly deallocates a statement named `prepare`
 * (probe-verified against PGlite). This lookahead is load-bearing: decoding
 * `DEALLOCATE PREPARE foo` as `{ name: 'prepare' }` after the backend
 * deallocated `foo` would be a genuine false eviction.
 *
 * Decoded names are returned in FULL — no 63-byte truncation. pg's
 * parse-skip cache is keyed by the original JavaScript protocol name, so the
 * exact spelling is the only correct deletion key; a different spelling that
 * the server truncates to the same identity is a documented fail-closed miss
 * (26000 on that name's next use), never a false eviction.
 *
 * Out of scope (all fail closed): comments anywhere — including a comment
 * between a command word and a quoted target — multi-statement text,
 * `U&"..."` Unicode-escape syntax, and truncation-equivalent long-name
 * aliases; only a `"` may immediately follow a command word without
 * whitespace, never any other zero-whitespace form. The caller mutates
 * caches only after the backend CONFIRMED the command, so over-acceptance
 * here (e.g. a reserved word as an unquoted target) is bounded by the server
 * rejecting the SQL.
 *
 * The decoder runs on every ordinary query text: after skipping leading
 * whitespace it bails on the first code unit unless it can begin `DEALLOCATE`
 * or `DISCARD`, and it allocates nothing before a complete command prefix
 * matched.
 *
 * @internal
 */
export type StatementCacheInvalidation = { all: true } | { name: string };

const isWs = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c || c === 0x0b;

const isIdentStart = (c: number): boolean =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c >= 0x80;

const isIdentCont = (c: number): boolean =>
  isIdentStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x24;

const skipWs = (text: string, from: number): number => {
  let i = from;
  while (i < text.length && isWs(text.charCodeAt(i))) i++;
  return i;
};

/** Where the target begins after a command word ends at `keywordEnd`. Real
 *  whitespace is the ordinary separator; a `"` immediately after the keyword
 *  is also a boundary because a delimited identifier cannot continue the
 *  preceding token (`DEALLOCATE"x"` is a command; `DEALLOCATEx` is one
 *  identifier). Returns the target start, or -1 when no separator is present.
 *  The explicit EOF bounds check keeps bare `DEALLOCATE PREPARE` on the
 *  fallback path where PREPARE is itself the target. */
const targetStartAfterKeyword = (text: string, keywordEnd: number): number => {
  const afterWs = skipWs(text, keywordEnd);
  if (afterWs > keywordEnd) return afterWs;
  return keywordEnd < text.length && text.charCodeAt(keywordEnd) === 0x22 /* " */ ? keywordEnd : -1;
};

/** Match an UPPERCASE ASCII keyword case-insensitively at `from`; the match
 *  must end on a token boundary (EOF or a non-identifier code unit — a
 *  non-ASCII continuation like `DEALLOCATEÜ` is one identifier, not a
 *  command). Returns the index past the keyword, or -1. */
const matchKeyword = (text: string, from: number, keyword: string): number => {
  if (from + keyword.length > text.length) return -1;
  for (let k = 0; k < keyword.length; k++) {
    const c = text.charCodeAt(from + k);
    const upper = c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
    if (upper !== keyword.charCodeAt(k)) return -1;
  }
  const end = from + keyword.length;
  if (end < text.length && isIdentCont(text.charCodeAt(end))) return -1;
  return end;
};

/** Only ASCII whitespace, one optional semicolon, more whitespace, EOF. A
 *  second semicolon or any other token means unsupported (multi-statement)
 *  text — the caller fails closed. */
const isTrailer = (text: string, from: number): boolean => {
  let i = skipWs(text, from);
  if (i < text.length && text.charCodeAt(i) === 0x3b /* ; */) i = skipWs(text, i + 1);
  return i === text.length;
};

/** PostgreSQL regular identifier with ASCII-only downcasing: `A-Z` fold to
 *  `a-z` (+0x20); digits, `_`, `$`, and every code unit >= 0x80 are kept
 *  exactly (matching PGlite's UTF-8 scanner, which preserves multibyte
 *  characters when folding). */
const scanRegularIdentifier = (
  text: string,
  from: number,
): { name: string; next: number } | null => {
  if (from >= text.length || !isIdentStart(text.charCodeAt(from))) return null;
  let end = from + 1;
  while (end < text.length && isIdentCont(text.charCodeAt(end))) end++;
  let name = '';
  for (let i = from; i < end; i++) {
    const c = text.charCodeAt(i);
    name += c >= 0x41 && c <= 0x5a ? String.fromCharCode(c + 0x20) : (text[i] as string);
  }
  return { name, next: end };
};

/** Delimited identifier starting at a `"`: `""` decodes to one literal `"`;
 *  everything else — whitespace, semicolons, comment-like text, case,
 *  non-ASCII — is identifier content kept verbatim. Empty (`""` alone) and
 *  unterminated identifiers reject. */
const scanDelimitedIdentifier = (
  text: string,
  from: number,
): { name: string; next: number } | null => {
  let name = '';
  let i = from + 1;
  while (i < text.length) {
    if (text.charCodeAt(i) === 0x22 /* " */) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x22) {
        name += '"';
        i += 2;
        continue;
      }
      return name === '' ? null : { name, next: i + 1 };
    }
    name += text[i] as string;
    i++;
  }
  return null;
};

/** One DEALLOCATE target: `ALL` (any ASCII case, unquoted only — the fold
 *  produces `all`), a regular identifier, or a delimited identifier. Quoted
 *  `"all"` stays a name. */
const scanTarget = (
  text: string,
  from: number,
): { invalidation: StatementCacheInvalidation; next: number } | null => {
  if (from < text.length && text.charCodeAt(from) === 0x22 /* " */) {
    const delimited = scanDelimitedIdentifier(text, from);
    return delimited === null
      ? null
      : { invalidation: { name: delimited.name }, next: delimited.next };
  }
  const regular = scanRegularIdentifier(text, from);
  if (regular === null) return null;
  return {
    invalidation: regular.name === 'all' ? { all: true } : { name: regular.name },
    next: regular.next,
  };
};

/** Decode `text` into the statement-cache invalidation it denotes, or null
 *  when the text is not (supported) invalidation syntax — see the module
 *  comment for the exact grammar and the fail-closed contract. */
export const decodeStatementCacheInvalidation = (
  text: string,
): StatementCacheInvalidation | null => {
  const start = skipWs(text, 0);
  if (start >= text.length) return null;
  // Fast common-query rejection: both commands begin with ASCII D/d.
  const first = text.charCodeAt(start);
  if (first !== 0x44 && first !== 0x64) return null;

  const afterDiscard = matchKeyword(text, start, 'DISCARD');
  if (afterDiscard !== -1) {
    // DISCARD PLANS/SEQUENCES/TEMP leave prepared statements intact — only
    // ALL carries DEALLOCATE-ALL semantics.
    const allAt = skipWs(text, afterDiscard);
    if (allAt === afterDiscard) return null;
    const afterAll = matchKeyword(text, allAt, 'ALL');
    if (afterAll === -1) return null;
    return isTrailer(text, afterAll) ? { all: true } : null;
  }

  const afterDealloc = matchKeyword(text, start, 'DEALLOCATE');
  if (afterDealloc === -1) return null;
  // A separator — whitespace, or a `"` opening a delimited identifier — must
  // follow the keyword; `DEALLOCATEfoo` is one identifier (fail closed).
  const targetAt = targetStartAfterKeyword(text, afterDealloc);
  if (targetAt === -1) return null;

  // Optional PREPARE: consumed as a keyword only when a complete target and
  // trailer follow; otherwise it is itself the target (see module comment).
  const afterPrepare = matchKeyword(text, targetAt, 'PREPARE');
  if (afterPrepare !== -1) {
    const keywordTargetAt = targetStartAfterKeyword(text, afterPrepare);
    if (keywordTargetAt !== -1) {
      const target = scanTarget(text, keywordTargetAt);
      if (target !== null && isTrailer(text, target.next)) return target.invalidation;
    }
  }

  const target = scanTarget(text, targetAt);
  if (target === null) return null;
  return isTrailer(text, target.next) ? target.invalidation : null;
};
