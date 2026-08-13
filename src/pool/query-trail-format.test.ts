/**
 * Formatter contract tests for `formatQueryTrail` (design:
 * .claude/plans/query-trail-design.md §5, §7 "Formatter unit").
 *
 * These tests DEFINE the on-failure trail output. Every expected string
 * below is the spec: the human format is asserted by exact equality (the
 * repo asserts concrete values, never `toMatchSnapshot`), and the JSONL
 * format is asserted line-by-line by parsing. `QueryTrailEntry` /
 * `QueryTrailMeta` objects are built as plain literals — the exported
 * types are the contract the formatter reads.
 *
 * Format pinned here (human):
 *
 *   pglite-bridge query trail — <n> queries[, <m> dropped][, disabled after entry <N>]
 *   #<seq> c<clientId> <duration|pending> <KIND> · <sql> · <params>
 *       ↳ error <code>: <message>          (only when the entry errored)
 *
 * - Header em-dash is U+2014 ("—"); the SQL/params separator is " · "
 *   (U+00B7 with surrounding spaces).
 * - Duration renders as `<n>ms` for a settled entry, the literal token
 *   `pending` for a pending one (never both).
 * - KIND is the uppercased kind label; transaction boundaries render FLAT
 *   at the same left column as ordinary queries — no indentation nesting.
 * - Params render as a JSON-ish array `[a, b]`; an empty params list is
 *   omitted entirely (no trailing separator).
 * - An entry error is rendered on its own indented continuation line,
 *   prominent, carrying code + message.
 * - No `atMs`, no wall-clock, nothing random appears — same input yields
 *   identical output.
 */
import { describe, expect, it } from 'vitest';
import type { QueryTrailEntry, QueryTrailMeta } from './query-trail.ts';
import { formatQueryTrail } from './query-trail-format.ts';

/** A settled ordinary-query entry with sane defaults; override per test. */
const entry = (over: Partial<QueryTrailEntry> = {}): QueryTrailEntry => ({
  seq: 0,
  atMs: 12.5, // deliberately non-zero: the formatter must NOT render it
  clientId: 0,
  sql: 'SELECT 1',
  params: [],
  kind: 'query',
  status: 'settled',
  durationMs: 1,
  rowCount: 1,
  ...over,
});

const NO_META: QueryTrailMeta = { droppedCount: 0 };

/** Split into lines. */
const lines = (out: string): string[] => out.split('\n');

/** Nth line as a definite `string` (strict-safe indexing). Throws if the
 *  line is absent — a missing line means the formatter produced fewer lines
 *  than the test expects, which is itself a failure worth surfacing. */
const lineAt = (out: string, n: number): string => {
  const line = out.split('\n')[n];
  if (line === undefined) throw new Error(`expected a line at index ${n}, got fewer lines`);
  return line;
};

describe('formatQueryTrail — human format header', () => {
  it('renders a header-only body for an empty trail', () => {
    expect(formatQueryTrail([], NO_META)).toBe('pglite-bridge query trail — 0 queries');
  });

  it('counts queries in the header (singular count still says "queries")', () => {
    const out = formatQueryTrail([entry()], NO_META);
    expect(lineAt(out, 0)).toBe('pglite-bridge query trail — 1 queries');
  });

  it('renders the test name in the header when provided', () => {
    const out = formatQueryTrail([entry()], NO_META, { testName: 'creates a tenant' });
    expect(lineAt(out, 0)).toBe('pglite-bridge query trail — 1 queries — test "creates a tenant"');
  });

  it('appends ", <m> dropped" when meta.droppedCount > 0', () => {
    const out = formatQueryTrail([entry()], { droppedCount: 132 });
    expect(lineAt(out, 0)).toBe('pglite-bridge query trail — 1 queries, 132 dropped');
  });

  it('appends ", disabled after entry <N>" when meta.disabledAfterSeq is set', () => {
    const out = formatQueryTrail([entry()], { droppedCount: 0, disabledAfterSeq: 7 });
    expect(lineAt(out, 0)).toBe('pglite-bridge query trail — 1 queries, disabled after entry 7');
  });

  it('renders dropped, disabled and test name together in header order', () => {
    const out = formatQueryTrail(
      [entry()],
      { droppedCount: 5, disabledAfterSeq: 9 },
      {
        testName: 'wide failure',
      },
    );
    expect(lineAt(out, 0)).toBe(
      'pglite-bridge query trail — 1 queries, 5 dropped, disabled after entry 9 — test "wide failure"',
    );
  });
});

describe('formatQueryTrail — human format entry lines', () => {
  it('renders seq, client tag, duration, kind, sql for a bare settled query', () => {
    const out = formatQueryTrail(
      [entry({ seq: 0, clientId: 0, sql: 'SELECT 1', durationMs: 2 })],
      NO_META,
    );
    expect(out).toBe(
      ['pglite-bridge query trail — 1 queries', '#0 c0 2ms QUERY · SELECT 1'].join('\n'),
    );
  });

  it('renders params as a bracketed list after a separator', () => {
    const out = formatQueryTrail(
      [
        entry({
          seq: 3,
          clientId: 1,
          sql: 'SELECT * FROM users WHERE id = $1',
          params: ['42'],
          durationMs: 1,
        }),
      ],
      NO_META,
    );
    expect(lineAt(out, 1)).toBe('#3 c1 1ms QUERY · SELECT * FROM users WHERE id = $1 · [42]');
  });

  it('renders multiple params comma-separated inside the bracket', () => {
    const out = formatQueryTrail(
      [
        entry({
          sql: 'INSERT INTO users (name, age) VALUES ($1, $2)',
          params: ['Ada', '36'],
        }),
      ],
      NO_META,
    );
    expect(lineAt(out, 1)).toBe(
      '#0 c0 1ms QUERY · INSERT INTO users (name, age) VALUES ($1, $2) · [Ada, 36]',
    );
  });

  it('omits the params section entirely when there are no params', () => {
    const out = formatQueryTrail([entry({ sql: 'SELECT now()', params: [] })], NO_META);
    // No trailing " · " and no empty "[]" — the line ends at the SQL.
    expect(lineAt(out, 1)).toBe('#0 c0 1ms QUERY · SELECT now()');
  });

  it('marks a pending entry with the literal "pending" token and no duration', () => {
    const out = formatQueryTrail(
      [
        entry({
          sql: 'INSERT INTO users (name) VALUES ($1)',
          params: ['Ada'],
          status: 'pending',
          durationMs: undefined,
          rowCount: undefined,
        }),
      ],
      NO_META,
    );
    expect(lineAt(out, 1)).toBe(
      '#0 c0 pending QUERY · INSERT INTO users (name) VALUES ($1) · [Ada]',
    );
  });

  it('renders an entry error on an indented continuation line with code and message', () => {
    const out = formatQueryTrail(
      [
        entry({
          seq: 4,
          sql: 'INSERT INTO users (email) VALUES ($1)',
          params: ['dup@example.com'],
          durationMs: 3,
          rowCount: null,
          error: { code: '23505', message: 'duplicate key value violates unique constraint' },
        }),
      ],
      NO_META,
    );
    expect(out).toBe(
      [
        'pglite-bridge query trail — 1 queries',
        '#4 c0 3ms QUERY · INSERT INTO users (email) VALUES ($1) · [dup@example.com]',
        '    ↳ error 23505: duplicate key value violates unique constraint',
      ].join('\n'),
    );
  });

  it('renders an error without a code as just the message', () => {
    const out = formatQueryTrail(
      [entry({ sql: 'SELECT bad', error: { message: 'syntax error at or near "bad"' } })],
      NO_META,
    );
    expect(lineAt(out, 2)).toBe('    ↳ error: syntax error at or near "bad"');
  });
});

describe('formatQueryTrail — flat transaction boundaries ([tribunal])', () => {
  // A transaction wrapping a query: BEGIN, the query, COMMIT. The design
  // mandates FLAT labeled boundaries — the query inside the tx must start at
  // the SAME left column as the boundaries, never indented under BEGIN.
  const txTrail: QueryTrailEntry[] = [
    entry({ seq: 0, kind: 'begin', sql: 'BEGIN', durationMs: 1, rowCount: null }),
    entry({
      seq: 1,
      kind: 'query',
      sql: 'INSERT INTO users (name) VALUES ($1)',
      params: ['Ada'],
      durationMs: 1,
    }),
    entry({ seq: 2, kind: 'commit', sql: 'COMMIT', durationMs: 1, rowCount: null }),
  ];

  it('labels BEGIN/COMMIT as flat entries with an uppercase kind', () => {
    const out = formatQueryTrail(txTrail, NO_META);
    expect(lineAt(out, 1)).toBe('#0 c0 1ms BEGIN · BEGIN');
    expect(lineAt(out, 2)).toBe('#1 c0 1ms QUERY · INSERT INTO users (name) VALUES ($1) · [Ada]');
    expect(lineAt(out, 3)).toBe('#2 c0 1ms COMMIT · COMMIT');
  });

  it('does NOT indent the query nested inside the transaction', () => {
    const out = formatQueryTrail(txTrail, NO_META);
    // Every entry line starts with "#" at column 0 — no leading whitespace
    // that would encode nesting. The only indented line the formatter ever
    // emits is an error continuation ("    ↳"), which none of these have.
    const entryLines = lines(out).slice(1);
    for (const line of entryLines) {
      expect(line.startsWith('#')).toBe(true);
    }
    // Concretely: the in-transaction query column equals the BEGIN column.
    expect(lineAt(out, 2).indexOf('#')).toBe(lineAt(out, 1).indexOf('#'));
  });

  it('renders the full savepoint vocabulary with distinct uppercase labels', () => {
    const lines = formatQueryTrail(
      [
        entry({ seq: 0, kind: 'savepoint', sql: 'SAVEPOINT s1', durationMs: 1, rowCount: null }),
        entry({
          seq: 1,
          kind: 'rollback-to',
          sql: 'ROLLBACK TO SAVEPOINT s1',
          durationMs: 1,
          rowCount: null,
        }),
        entry({
          seq: 2,
          kind: 'release',
          sql: 'RELEASE SAVEPOINT s1',
          durationMs: 1,
          rowCount: null,
        }),
        entry({ seq: 3, kind: 'rollback', sql: 'ROLLBACK', durationMs: 1, rowCount: null }),
      ],
      NO_META,
    ).split('\n');
    expect(lines[1]).toBe('#0 c0 1ms SAVEPOINT · SAVEPOINT s1');
    expect(lines[2]).toBe('#1 c0 1ms ROLLBACK-TO · ROLLBACK TO SAVEPOINT s1');
    expect(lines[3]).toBe('#2 c0 1ms RELEASE · RELEASE SAVEPOINT s1');
    expect(lines[4]).toBe('#3 c0 1ms ROLLBACK · ROLLBACK');
  });
});

describe('formatQueryTrail — client tags distinguish concurrent clients', () => {
  it('renders each entry with its own c<clientId> tag', () => {
    const lines = formatQueryTrail(
      [
        entry({ seq: 0, clientId: 0, sql: 'SELECT 1' }),
        entry({ seq: 1, clientId: 1, sql: 'SELECT 2' }),
      ],
      NO_META,
    ).split('\n');
    expect(lines[1]).toBe('#0 c0 1ms QUERY · SELECT 1');
    expect(lines[2]).toBe('#1 c1 1ms QUERY · SELECT 2');
  });
});

describe('formatQueryTrail — determinism', () => {
  it('produces identical output for identical input (no timestamps/randomness)', () => {
    const trail = [
      entry({ seq: 0, kind: 'begin', sql: 'BEGIN', durationMs: 1, rowCount: null }),
      entry({ seq: 1, sql: 'SELECT * FROM users WHERE id = $1', params: ['1'], durationMs: 2 }),
      entry({
        seq: 2,
        sql: 'UPDATE users SET name = $1 WHERE id = $2',
        params: ['Grace', '1'],
        status: 'pending',
        durationMs: undefined,
      }),
    ];
    const meta: QueryTrailMeta = { droppedCount: 3, disabledAfterSeq: undefined };
    expect(formatQueryTrail(trail, meta, { testName: 'x' })).toBe(
      formatQueryTrail(trail, meta, { testName: 'x' }),
    );
  });

  it('does not leak the atMs field into the rendered output', () => {
    const out = formatQueryTrail([entry({ atMs: 999_999 })], NO_META);
    expect(out).not.toContain('999999');
    expect(out).not.toContain('999_999');
  });
});

describe('formatQueryTrail — JSONL format', () => {
  const trail: QueryTrailEntry[] = [
    entry({ seq: 0, kind: 'begin', sql: 'BEGIN', durationMs: 1, rowCount: null }),
    entry({
      seq: 1,
      clientId: 0,
      sql: 'INSERT INTO users (name) VALUES ($1)',
      params: ['Ada'],
      durationMs: 2,
      rowCount: 1,
    }),
    entry({
      seq: 2,
      clientId: 0,
      sql: 'SELECT * FROM users WHERE id = $1',
      params: ['1'],
      status: 'pending',
      durationMs: undefined,
      rowCount: undefined,
    }),
  ];

  it('emits one JSON line per entry plus a leading header line', () => {
    const out = formatQueryTrail(trail, { droppedCount: 4 }, { format: 'json' });
    // Line count = entries + 1 header line.
    expect(lines(out)).toHaveLength(trail.length + 1);
    for (const line of lines(out)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  it('first line is the trail-header event with formatVersion 1', () => {
    const out = formatQueryTrail(
      trail,
      { droppedCount: 4 },
      { format: 'json', testName: 'creates a tenant' },
    );
    expect(JSON.parse(lineAt(out, 0))).toEqual({
      type: 'trail-header',
      formatVersion: 1,
      testName: 'creates a tenant',
      droppedCount: 4,
      // `disabled` is `false` when capture was not disabled; when disabled it
      // carries the seq. This trail was not disabled.
      disabled: false,
    });
  });

  it('carries the disabling seq in the header when capture was disabled', () => {
    const out = formatQueryTrail(
      [entry()],
      { droppedCount: 0, disabledAfterSeq: 11 },
      { format: 'json' },
    );
    expect(JSON.parse(lineAt(out, 0))).toEqual({
      type: 'trail-header',
      formatVersion: 1,
      testName: undefined,
      droppedCount: 0,
      disabled: 11,
    });
  });

  it('each entry line parses to the exact entry shape (settled row)', () => {
    const out = formatQueryTrail(trail, { droppedCount: 4 }, { format: 'json' });
    expect(JSON.parse(lineAt(out, 2))).toEqual({
      seq: 1,
      atMs: 12.5,
      clientId: 0,
      sql: 'INSERT INTO users (name) VALUES ($1)',
      params: ['Ada'],
      kind: 'query',
      status: 'settled',
      durationMs: 2,
      rowCount: 1,
    });
  });

  it('preserves the pending status and the params array on a pending entry', () => {
    const out = formatQueryTrail(trail, { droppedCount: 4 }, { format: 'json' });
    const parsed = JSON.parse(lineAt(out, 3));
    expect(parsed.status).toBe('pending');
    expect(parsed.seq).toBe(2);
    expect(parsed.params).toEqual(['1']);
    // A pending entry has not settled: no duration, no rowCount.
    expect(parsed.durationMs).toBeUndefined();
    expect(parsed.rowCount).toBeUndefined();
  });

  it('preserves the error object on an errored entry line', () => {
    const errTrail = [
      entry({
        seq: 0,
        sql: 'INSERT INTO users (email) VALUES ($1)',
        params: ['dup@example.com'],
        durationMs: 1,
        rowCount: null,
        error: { code: '23505', message: 'duplicate key' },
      }),
    ];
    const out = formatQueryTrail(errTrail, NO_META, { format: 'json' });
    expect(JSON.parse(lineAt(out, 1)).error).toEqual({ code: '23505', message: 'duplicate key' });
  });

  it('emits a header-only single line for an empty trail in JSON mode', () => {
    const out = formatQueryTrail([], NO_META, { format: 'json' });
    expect(out.split('\n')).toHaveLength(1);
    expect(JSON.parse(out)).toEqual({
      type: 'trail-header',
      formatVersion: 1,
      testName: undefined,
      droppedCount: 0,
      disabled: false,
    });
  });

  it('is deterministic in JSON mode too', () => {
    const a = formatQueryTrail(trail, { droppedCount: 4 }, { format: 'json' });
    const b = formatQueryTrail(trail, { droppedCount: 4 }, { format: 'json' });
    expect(a).toBe(b);
  });
});
