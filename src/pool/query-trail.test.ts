import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TRAIL_MAX_PARAM_CHARS,
  QueryTrailRecorder,
  TRAIL_SQL_MAX_CHARS,
} from './query-trail.ts';

// Red-phase TDD spec for QueryTrailRecorder (design:
// .claude/plans/query-trail-design.md §4 capture + §7 unit bullets). Every
// stub in query-trail.ts throws 'not implemented', so every test here is RED
// until the recorder lands.
//
// The recorder is a pool-owned ring buffer: begin() appends a pending entry
// at submission, the returned handle's settle() completes it, and capture
// NEVER throws into a user's query — an internal capture error appends a
// sentinel entry, disables further capture, and warns once on stderr.
//
// Contract resolutions made here (each becomes the spec; listed in the return
// summary):
//  - SQL cap notation: capped text is truncated to TRAIL_SQL_MAX_CHARS total
//    characters INCLUDING a trailing ` … [capped]` marker, so `sql.length`
//    never exceeds TRAIL_SQL_MAX_CHARS and the marker is always the suffix.
//  - Error-message cap: 500 characters (message longer than the cap is
//    truncated to exactly 500 characters).
//  - Sentinel entry: a settled entry whose sql is `<trail capture disabled>`
//    and kind is 'query'; meta().disabledAfterSeq carries its seq.
describe('QueryTrailRecorder', () => {
  const ERROR_MESSAGE_MAX_CHARS = 500;

  // Spy on process.stderr.write per test; restoreMocks in vitest.config clears
  // it between tests. Returns the written string chunks for assertions.
  const spyStderr = (): { writes: string[]; spy: ReturnType<typeof vi.spyOn> } => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
        return true;
      });
    return { writes, spy };
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('begin / settle lifecycle', () => {
    it('appends a pending entry on begin and completes it on settle', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      const handle = recorder.begin(clientId, 'SELECT 1 AS x', [42]);

      const pending = recorder.entries();
      expect(pending).toHaveLength(1);
      const entry = pending[0];
      if (entry === undefined) throw new Error('no pending entry');
      expect(entry.status).toBe('pending');
      expect(entry.seq).toBe(0);
      expect(entry.atMs).toBeGreaterThanOrEqual(0);
      expect(entry.clientId).toBe(clientId);
      expect(entry.sql).toBe('SELECT 1 AS x');
      expect(entry.params).toEqual(['42']);
      expect(entry.kind).toBe('query');
      // Pending entries carry no duration/rowCount/error yet.
      expect(entry.durationMs).toBeUndefined();
      expect(entry.rowCount).toBeUndefined();
      expect(entry.error).toBeUndefined();

      handle.settle({ rowCount: 1 });

      const settled = recorder.entries()[0];
      if (settled === undefined) throw new Error('entry vanished after settle');
      expect(settled.status).toBe('settled');
      expect(settled.rowCount).toBe(1);
      expect(settled.durationMs).toBeGreaterThanOrEqual(0);
      expect(settled.error).toBeUndefined();
    });

    it('records rowCount null verbatim on settle', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      const handle = recorder.begin(clientId, 'CREATE TABLE t (id int)');

      handle.settle({ rowCount: null });

      const entry = recorder.entries()[0];
      expect(entry?.status).toBe('settled');
      expect(entry?.rowCount).toBeNull();
    });

    it('is idempotent — the second settle is ignored (first call wins)', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      const handle = recorder.begin(clientId, 'SELECT 1');

      handle.settle({ rowCount: 3 });
      const afterFirst = recorder.entries()[0];
      const firstDuration = afterFirst?.durationMs;
      expect(afterFirst?.rowCount).toBe(3);

      // Second settle with different data must not overwrite.
      handle.settle({ rowCount: 99, error: new Error('late') });

      const afterSecond = recorder.entries()[0];
      expect(afterSecond?.rowCount).toBe(3);
      expect(afterSecond?.error).toBeUndefined();
      expect(afterSecond?.durationMs).toBe(firstDuration);
    });

    it('assigns increasing seq across successive begins on one client', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT 1');
      recorder.begin(clientId, 'SELECT 2');
      recorder.begin(clientId, 'SELECT 3');

      expect(recorder.entries().map((e) => e.seq)).toEqual([0, 1, 2]);
    });
  });

  describe('error settle', () => {
    it('records code (string) and message from an error object', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      const handle = recorder.begin(clientId, 'SELECT bad');

      const err = Object.assign(new Error('syntax error at or near "bad"'), { code: '42601' });
      handle.settle({ error: err });

      const entry = recorder.entries()[0];
      expect(entry?.status).toBe('settled');
      expect(entry?.error).toEqual({ code: '42601', message: 'syntax error at or near "bad"' });
    });

    it('omits code when err.code is not a string', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      const handle = recorder.begin(clientId, 'SELECT 1');

      // A numeric code must not be recorded as a string code.
      const err = Object.assign(new Error('boom'), { code: 500 });
      handle.settle({ error: err });

      const entry = recorder.entries()[0];
      expect(entry?.error).toEqual({ message: 'boom' });
      expect(entry?.error && 'code' in entry.error).toBe(false);
    });

    it('caps the error message at 500 characters', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      const handle = recorder.begin(clientId, 'SELECT 1');

      const longMessage = 'x'.repeat(ERROR_MESSAGE_MAX_CHARS + 250);
      handle.settle({ error: new Error(longMessage) });

      const message = recorder.entries()[0]?.error?.message ?? '';
      expect(message).toHaveLength(ERROR_MESSAGE_MAX_CHARS);
    });

    it('renders a non-Error thrown value as a string message', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      const handle = recorder.begin(clientId, 'SELECT 1');

      handle.settle({ error: 'plain string failure' });

      const entry = recorder.entries()[0];
      expect(entry?.error?.message).toBe('plain string failure');
      expect(entry?.error && 'code' in entry.error).toBe(false);
    });
  });

  describe('kind derivation', () => {
    const kindOf = (sql: string): string => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      recorder.begin(clientId, sql);
      const entry = recorder.entries()[0];
      if (entry === undefined) throw new Error('no entry');
      return entry.kind;
    };

    it.each([
      ['BEGIN', 'begin'],
      ['START TRANSACTION', 'begin'],
      ['COMMIT', 'commit'],
      ['END', 'commit'],
      ['ROLLBACK', 'rollback'],
      ['ROLLBACK TO SAVEPOINT sp1', 'rollback-to'],
      ['ROLLBACK TO sp1', 'rollback-to'],
      ['SAVEPOINT sp1', 'savepoint'],
      ['RELEASE SAVEPOINT sp1', 'release'],
      ['RELEASE sp1', 'release'],
      ['SELECT 1', 'query'],
      ['CREATE TABLE t (id int)', 'query'],
      ['INSERT INTO t VALUES (1)', 'query'],
    ])('classifies %s as %s', (sql, expected) => {
      expect(kindOf(sql)).toBe(expected);
    });

    it('classifies lowercase transaction keywords', () => {
      expect(kindOf('begin')).toBe('begin');
      expect(kindOf('commit')).toBe('commit');
      expect(kindOf('rollback')).toBe('rollback');
      expect(kindOf('savepoint sp1')).toBe('savepoint');
    });

    it('tolerates leading whitespace and newlines', () => {
      expect(kindOf('   \n\t BEGIN')).toBe('begin');
      expect(kindOf('\n  COMMIT')).toBe('commit');
    });

    it('skips a leading line comment before the keyword', () => {
      expect(kindOf('-- start the tx\nBEGIN')).toBe('begin');
    });

    it('skips a leading block comment before the keyword', () => {
      expect(kindOf('/* c */ begin')).toBe('begin');
      expect(kindOf('/* multi\nline */\nROLLBACK')).toBe('rollback');
    });

    it('does not mis-bucket ROLLBACK TO as a plain rollback', () => {
      expect(kindOf('rollback to savepoint sp1')).toBe('rollback-to');
      expect(kindOf('ROLLBACK TO sp1')).toBe('rollback-to');
    });

    it('does not mis-bucket RELEASE SAVEPOINT as a query', () => {
      expect(kindOf('release savepoint sp1')).toBe('release');
    });
  });

  describe('param previews — capture-time renders, never live references', () => {
    const previewOf = (value: unknown): string => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      recorder.begin(clientId, 'SELECT $1', [value]);
      const params = recorder.entries()[0]?.params ?? [];
      const first = params[0];
      if (first === undefined) throw new Error('no param preview');
      return first;
    };

    it('stringifies numbers, booleans, and bigints', () => {
      expect(previewOf(42)).toBe('42');
      expect(previewOf(0)).toBe('0');
      expect(previewOf(true)).toBe('true');
      expect(previewOf(false)).toBe('false');
      expect(previewOf(9007199254740993n)).toBe('9007199254740993');
    });

    it('renders a Date as its ISO string', () => {
      const date = new Date('2026-08-11T10:20:30.000Z');
      expect(previewOf(date)).toBe('2026-08-11T10:20:30.000Z');
    });

    it('tags null as <null> and undefined as <undefined>', () => {
      expect(previewOf(null)).toBe('<null>');
      expect(previewOf(undefined)).toBe('<undefined>');
    });

    it('renders a Uint8Array as <bytes:N> with N the byte count', () => {
      expect(previewOf(new Uint8Array([1, 2, 3, 4, 5]))).toBe('<bytes:5>');
    });

    it('renders a Buffer as <bytes:N> with N the byte count', () => {
      expect(previewOf(Buffer.from('hello world'))).toBe('<bytes:11>');
    });

    it('truncates an over-long string at the default 200-char cap', () => {
      const long = 'a'.repeat(500);
      const preview = previewOf(long);
      // The rendered preview never exceeds the cap.
      expect(preview.length).toBeLessThanOrEqual(DEFAULT_TRAIL_MAX_PARAM_CHARS);
      // The prefix is preserved.
      expect(preview.startsWith('a'.repeat(50))).toBe(true);
    });

    it('honors a custom maxParamChars', () => {
      const recorder = new QueryTrailRecorder({ maxParamChars: 10 });
      const clientId = recorder.registerClient();
      recorder.begin(clientId, 'SELECT $1', ['abcdefghijklmnop']);
      const preview = recorder.entries()[0]?.params[0] ?? '';
      expect(preview.length).toBeLessThanOrEqual(10);
    });

    it('does not leak later mutation of the caller values array into the preview', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      const values: unknown[] = ['original'];

      recorder.begin(clientId, 'SELECT $1', values);
      // Mutate the caller's array AFTER begin() — the recorded preview must be
      // the capture-time render, not a live reference.
      values[0] = 'mutated';
      values.push('extra');

      expect(recorder.entries()[0]?.params).toEqual(['original']);
    });

    it('redactParams renders every param as <redacted>', () => {
      const recorder = new QueryTrailRecorder({ redactParams: true });
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT $1, $2, $3', ['secret', 12345, null]);

      expect(recorder.entries()[0]?.params).toEqual(['<redacted>', '<redacted>', '<redacted>']);
    });

    it('records an empty params array when no values are supplied', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();
      recorder.begin(clientId, 'SELECT 1');
      expect(recorder.entries()[0]?.params).toEqual([]);
    });
  });

  describe('sql cap', () => {
    it('caps sql at TRAIL_SQL_MAX_CHARS and notes the cap in the stored text', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      const longSql = `SELECT ${'x'.repeat(TRAIL_SQL_MAX_CHARS + 500)}`;
      recorder.begin(clientId, longSql);

      const stored = recorder.entries()[0]?.sql ?? '';
      // Total stored length never exceeds the cap, and the cap marker is the
      // trailing suffix (resolved notation: ` … [capped]`).
      expect(stored.length).toBeLessThanOrEqual(TRAIL_SQL_MAX_CHARS);
      expect(stored.endsWith(' … [capped]')).toBe(true);
      expect(stored.startsWith('SELECT ')).toBe(true);
    });

    it('leaves sql at or under the cap untouched (no marker)', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT 1 AS x');

      const stored = recorder.entries()[0]?.sql ?? '';
      expect(stored).toBe('SELECT 1 AS x');
      expect(stored.includes('[capped]')).toBe(false);
    });
  });

  describe('ring overflow', () => {
    it('drops the oldest entries and tracks droppedCount accurately', () => {
      const recorder = new QueryTrailRecorder({ maxEntries: 3 });
      const clientId = recorder.registerClient();

      for (let i = 0; i < 5; i++) recorder.begin(clientId, `SELECT ${i}`);

      const entries = recorder.entries();
      expect(entries).toHaveLength(3);
      // The oldest two (SELECT 0, SELECT 1) were dropped; the newest three
      // remain, in submission order.
      expect(entries.map((e) => e.sql)).toEqual(['SELECT 2', 'SELECT 3', 'SELECT 4']);
      expect(entries.map((e) => e.seq)).toEqual([2, 3, 4]);
      expect(recorder.meta().droppedCount).toBe(2);
    });

    it('emits exactly one stderr warning on the FIRST overflow, none on the second', () => {
      const { writes } = spyStderr();
      const recorder = new QueryTrailRecorder({ maxEntries: 2 });
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT 0');
      recorder.begin(clientId, 'SELECT 1');
      expect(writes).toHaveLength(0);

      // First overflow — one warning.
      recorder.begin(clientId, 'SELECT 2');
      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/trail/i);

      // Second overflow — no new warning.
      recorder.begin(clientId, 'SELECT 3');
      expect(writes).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('empties entries, resets seq to 0, and resets droppedCount', () => {
      const recorder = new QueryTrailRecorder({ maxEntries: 2 });
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT 0');
      recorder.begin(clientId, 'SELECT 1');
      recorder.begin(clientId, 'SELECT 2'); // overflow → droppedCount 1
      expect(recorder.meta().droppedCount).toBe(1);

      recorder.clear();

      expect(recorder.entries()).toEqual([]);
      expect(recorder.meta().droppedCount).toBe(0);

      // seq is per-trail-relative — the next entry after clear() is seq 0.
      recorder.begin(clientId, 'SELECT after clear');
      expect(recorder.entries()[0]?.seq).toBe(0);
    });

    it('re-arms the first-overflow warning after clear()', () => {
      const { writes } = spyStderr();
      const recorder = new QueryTrailRecorder({ maxEntries: 1 });
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT 0');
      recorder.begin(clientId, 'SELECT 1'); // first overflow
      expect(writes).toHaveLength(1);

      recorder.clear();

      recorder.begin(clientId, 'SELECT 2');
      recorder.begin(clientId, 'SELECT 3'); // overflow again after clear
      expect(writes).toHaveLength(2);
    });
  });

  describe('entries() snapshot', () => {
    it('returns a snapshot copy — a retained reference is not mutated by later captures', () => {
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT 1');
      const captured = recorder.entries();
      expect(captured).toHaveLength(1);

      // Record another query AFTER capturing the reference — the retained array
      // must not grow underneath the caller.
      recorder.begin(clientId, 'SELECT 2');
      expect(captured).toHaveLength(1);
      expect(captured.map((e) => e.sql)).toEqual(['SELECT 1']);
    });
  });

  describe('registerClient', () => {
    it('returns stable ordinals 0, 1, 2 …', () => {
      const recorder = new QueryTrailRecorder();
      expect(recorder.registerClient()).toBe(0);
      expect(recorder.registerClient()).toBe(1);
      expect(recorder.registerClient()).toBe(2);
    });

    it('stamps each entry with its registering client ordinal', () => {
      const recorder = new QueryTrailRecorder();
      const a = recorder.registerClient();
      const b = recorder.registerClient();

      recorder.begin(a, 'SELECT a');
      recorder.begin(b, 'SELECT b');
      recorder.begin(a, 'SELECT a2');

      expect(recorder.entries().map((e) => e.clientId)).toEqual([a, b, a]);
      expect(a).not.toBe(b);
    });
  });

  describe('capture-error hardening', () => {
    // A value whose rendering the recorder must attempt at capture time and
    // which throws during that render — a getter on a plain object throwing
    // is the reliable trigger against the "render each param at capture"
    // contract.
    const explosiveValue = (): unknown => ({
      get poison(): never {
        throw new Error('render boom');
      },
      toString(): never {
        throw new Error('toString boom');
      },
    });

    it('does not throw out of begin() when capture fails internally', () => {
      const { spy } = spyStderr();
      spy.mockClear();
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      expect(() => recorder.begin(clientId, 'SELECT $1', [explosiveValue()])).not.toThrow();
    });

    it('appends a sentinel entry and sets meta().disabledAfterSeq on capture error', () => {
      spyStderr();
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT ok', [1]); // seq 0, clean
      recorder.begin(clientId, 'SELECT $1', [explosiveValue()]); // triggers disable

      const meta = recorder.meta();
      expect(meta.disabledAfterSeq).toBeTypeOf('number');

      // A sentinel entry marks the point of disablement.
      const entries = recorder.entries();
      const sentinel = entries.find((e) => e.sql === '<trail capture disabled>');
      expect(sentinel).toBeDefined();
      expect(sentinel?.kind).toBe('query');
      expect(sentinel?.seq).toBe(meta.disabledAfterSeq);
    });

    it('gives the settled sentinel a durationMs of 0 (never undefined)', () => {
      spyStderr();
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT $1', [explosiveValue()]); // disables

      const sentinel = recorder.entries().find((e) => e.sql === '<trail capture disabled>');
      expect(sentinel?.status).toBe('settled');
      // The human formatter renders `${durationMs}ms`; undefined would read
      // `undefinedms`, so the settled sentinel must carry a concrete 0.
      expect(sentinel?.durationMs).toBe(0);
    });

    it('is inert after disablement — subsequent begin() adds no new entries', () => {
      spyStderr();
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT $1', [explosiveValue()]); // disables
      const countAfterDisable = recorder.entries().length;

      recorder.begin(clientId, 'SELECT 1', [1]);
      recorder.begin(clientId, 'SELECT 2', [2]);

      expect(recorder.entries().length).toBe(countAfterDisable);
    });

    it('warns exactly once on stderr for the capture error', () => {
      const { writes } = spyStderr();
      const recorder = new QueryTrailRecorder();
      const clientId = recorder.registerClient();

      recorder.begin(clientId, 'SELECT $1', [explosiveValue()]); // disables + warns
      recorder.begin(clientId, 'SELECT $1', [explosiveValue()]); // inert, no new warn

      expect(writes).toHaveLength(1);
      expect(writes[0]).toMatch(/trail/i);
    });
  });
});
