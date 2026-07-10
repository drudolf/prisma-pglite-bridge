// Red-phase TDD spec for FastQuery — a lean pg Submittable fast path.
//
// `./fast-query.ts` does not exist yet, so this file fails at import until
// the implementation lands. FastQuery is a stripped-down stand-in for pg's
// stock Query (node_modules/pg/lib/query.js) covering exactly the shape
// @prisma/adapter-pg emits when statement caching names a query: named
// statement + rowMode 'array' + caller-supplied `types`, extended protocol
// only. A per-client fields cache lets warm executions skip the Describe
// round-trip; parsers are re-resolved from the CURRENT call's `types` on
// every execution.
import pg from 'pg';
import pgUtils from 'pg/lib/utils.js';
import { describe, expect, it, vi } from 'vitest';
import { FastQuery, type FastQueryField } from './fast-query.ts';

type ProtocolCall = { method: string; arg: unknown };

// Plain-object connection recording protocol calls in order. `stream` has
// no cork/uncork by default — submit's `?.()` must tolerate their absence;
// `withCork: true` installs recording spies for the cork-ordering test.
const createMockConnection = ({
  withCork = false,
  parsedStatements = {} as Record<string, string>,
}: {
  withCork?: boolean;
  parsedStatements?: Record<string, string>;
} = {}) => {
  const calls: ProtocolCall[] = [];
  const record =
    (method: string) =>
    (arg?: unknown): void => {
      calls.push({ method, arg });
    };
  const stream: { cork?: () => void; uncork?: () => void } = withCork
    ? {
        cork: () => {
          calls.push({ method: 'cork', arg: undefined });
        },
        uncork: () => {
          calls.push({ method: 'uncork', arg: undefined });
        },
      }
    : {};
  return {
    calls,
    methods: (): string[] => calls.map((call) => call.method),
    argOf: (method: string): unknown => calls.find((call) => call.method === method)?.arg,
    stream,
    parsedStatements,
    parse: record('parse'),
    bind: record('bind'),
    describe: record('describe'),
    execute: record('execute'),
    sync: record('sync'),
    sendCopyFail: record('sendCopyFail'),
  };
};

type Parser = (raw: string) => unknown;

const makeTypes = (
  parserFor: (oid: number, format: string) => Parser = () => (raw: string) => raw,
) => ({
  getTypeParser: vi.fn((oid: number, format?: string): Parser => parserFor(oid, format ?? 'text')),
});

const buildQuery = ({
  name = 'q1',
  text = 'SELECT $1::int AS n',
  values = [42] as unknown[] | undefined,
  types = makeTypes(),
  cache = new Map<string, FastQueryField[]>(),
} = {}) => {
  const query = new FastQuery({ name, text, values, types }, cache);
  return { query, types, cache };
};

describe('FastQuery — submit, cold path', () => {
  it('exposes name/text, returns null, and issues parse → bind → describe → execute → sync', () => {
    const conn = createMockConnection();
    const { query } = buildQuery();

    expect(query.name).toBe('q1');
    expect(query.text).toBe('SELECT $1::int AS n');
    expect(query.submit(conn)).toBeNull();

    // stream has no cork/uncork — tolerated, and every protocol step in order.
    expect(conn.methods()).toEqual(['parse', 'bind', 'describe', 'execute', 'sync']);
    expect(conn.argOf('parse')).toEqual({ text: 'SELECT $1::int AS n', name: 'q1', types: [] });
    expect(conn.argOf('bind')).toEqual({
      portal: '',
      statement: 'q1',
      values: [42],
      binary: false,
      valueMapper: pgUtils.prepareValue,
    });
    expect(conn.argOf('describe')).toEqual({ type: 'P', name: '' });
    expect(conn.argOf('execute')).toEqual({ portal: '', rows: 0 });
  });

  it('corks the stream before parse and uncorks after sync when available', () => {
    const conn = createMockConnection({ withCork: true });
    const { query } = buildQuery();

    expect(query.submit(conn)).toBeNull();
    expect(conn.methods()).toEqual([
      'cork',
      'parse',
      'bind',
      'describe',
      'execute',
      'sync',
      'uncork',
    ]);
  });
});

describe('FastQuery — submit, parse skipping', () => {
  it('skips parse when the connection already parsed this name with the same text', () => {
    const text = 'SELECT $1::int AS n';
    const conn = createMockConnection({ parsedStatements: { q1: text } });
    const { query } = buildQuery({ text });

    expect(query.submit(conn)).toBeNull();
    expect(conn.methods()).toEqual(['bind', 'describe', 'execute', 'sync']);
  });

  it('returns (not throws) the stock uniqueness error when the name maps to different text', () => {
    const conn = createMockConnection({ parsedStatements: { q1: 'SELECT 2' } });
    const { query } = buildQuery({ text: 'SELECT 1' });

    const err = query.submit(conn);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/Prepared statements must be unique/);
    // Client-side validation failure: no protocol traffic at all.
    expect(conn.calls).toEqual([]);
  });
});

describe('FastQuery — submit, warm path', () => {
  it('skips describe and builds parsers at submit time from the cached fields', async () => {
    const cache = new Map<string, FastQueryField[]>([['q1', [{ name: 'n', dataTypeID: 23 }]]]);
    const types = makeTypes(() => (raw) => `warm:${raw}`);
    const conn = createMockConnection();
    const { query } = buildQuery({ cache, types });

    expect(query.submit(conn)).toBeNull();
    expect(conn.methods()).toEqual(['parse', 'bind', 'execute', 'sync']);
    // Parsers resolved during submit — before any row arrives.
    expect(types.getTypeParser).toHaveBeenCalledWith(23, 'text');

    query.handleDataRow({ fields: ['7'] });
    query.handleCommandComplete({ text: 'SELECT 1' });
    query.handleReadyForQuery();
    await expect(query.promise).resolves.toMatchObject({ rows: [['warm:7']] });
  });

  it('re-resolves parsers from the current call types on a later execution', async () => {
    const cache = new Map<string, FastQueryField[]>();
    const text = 'SELECT n FROM t';

    // Cold execution resolves through typesA and caches the fields.
    const typesA = makeTypes(() => (raw) => `A:${raw}`);
    const first = new FastQuery({ name: 'q1', text, values: [], types: typesA }, cache);
    const connA = createMockConnection();
    expect(first.submit(connA)).toBeNull();
    first.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23, format: 'text' }] });
    first.handleDataRow({ fields: ['1'] });
    first.handleCommandComplete({ text: 'SELECT 1' });
    first.handleReadyForQuery();
    await expect(first.promise).resolves.toMatchObject({ rows: [['A:1']] });

    // Warm execution with a NEW types object: it must be consulted — parsers
    // are per-call, never frozen into the fields cache.
    const typesB = makeTypes(() => (raw) => `B:${raw}`);
    const second = new FastQuery({ name: 'q1', text, values: [], types: typesB }, cache);
    const connB = createMockConnection({ parsedStatements: { q1: text } });
    expect(second.submit(connB)).toBeNull();
    expect(connB.methods()).toEqual(['bind', 'execute', 'sync']);
    expect(typesB.getTypeParser).toHaveBeenCalledWith(23, 'text');

    second.handleDataRow({ fields: ['2'] });
    second.handleCommandComplete({ text: 'SELECT 1' });
    second.handleReadyForQuery();
    await expect(second.promise).resolves.toMatchObject({ rows: [['B:2']] });
  });
});

describe('FastQuery — handleRowDescription', () => {
  it('caches fields under the statement name and resolves a parser per column', () => {
    const { query, types, cache } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);

    query.handleRowDescription({
      fields: [
        { name: 'a', dataTypeID: 23, format: 'text' },
        { name: 'b', dataTypeID: 25 },
      ],
    });

    const cached = cache.get('q1');
    expect(cached).toHaveLength(2);
    expect(cached?.[0]).toMatchObject({ name: 'a', dataTypeID: 23 });
    expect(cached?.[1]).toMatchObject({ name: 'b', dataTypeID: 25 });
    expect(types.getTypeParser).toHaveBeenCalledWith(23, 'text');
    // Missing format defaults to 'text'.
    expect(types.getTypeParser).toHaveBeenCalledWith(25, 'text');
  });
});

describe('FastQuery — handleDataRow', () => {
  it('builds array rows through the resolved parsers and passes null through unparsed', async () => {
    const types = makeTypes((oid) => (oid === 23 ? (raw) => Number(raw) : (raw) => `t:${raw}`));
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);
    query.handleRowDescription({
      fields: [
        { name: 'a', dataTypeID: 23, format: 'text' },
        { name: 'b', dataTypeID: 25, format: 'text' },
      ],
    });

    query.handleDataRow({ fields: ['5', null] });
    query.handleDataRow({ fields: ['6', 'x'] });
    query.handleCommandComplete({ text: 'SELECT 2' });
    query.handleReadyForQuery();

    await expect(query.promise).resolves.toMatchObject({
      rows: [
        [5, null],
        [6, 't:x'],
      ],
    });
  });
});

describe('FastQuery — omitted values', () => {
  it('binds an empty values array when the config carries none', () => {
    const conn = createMockConnection();
    // Constructed without a `values` key at all — buildQuery's destructuring
    // default would replace an explicit `undefined`.
    const query = new FastQuery(
      { name: 'q1', text: 'SELECT 1', types: makeTypes() },
      new Map<string, FastQueryField[]>(),
    );

    expect(query.submit(conn)).toBeNull();
    expect(conn.argOf('bind')).toMatchObject({ values: [] });
  });
});

describe('FastQuery — handleCommandComplete', () => {
  it("parses a count-less tag like 'CREATE TABLE' into command only", async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);
    query.handleCommandComplete({ text: 'CREATE TABLE' });
    query.handleReadyForQuery();

    await expect(query.promise).resolves.toMatchObject({
      command: 'CREATE',
      rowCount: null,
      oid: null,
    });
  });

  it("parses 'SELECT 3' into command/rowCount with a null oid (full result shape)", async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);
    query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23, format: 'text' }] });
    query.handleCommandComplete({ text: 'SELECT 3' });
    query.handleReadyForQuery();

    // toEqual pins the exact FastQueryResult key set: a plain object, not
    // a pg.Result.
    await expect(query.promise).resolves.toEqual({
      rows: [],
      fields: [expect.objectContaining({ name: 'n', dataTypeID: 23 })],
      rowCount: 3,
      command: 'SELECT',
      oid: null,
    });
  });

  it("parses 'INSERT 0 5' into command/oid/rowCount", async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);
    query.handleCommandComplete({ text: 'INSERT 0 5' });
    query.handleReadyForQuery();

    await expect(query.promise).resolves.toMatchObject({
      command: 'INSERT',
      oid: 0,
      rowCount: 5,
      rows: [],
    });
  });
});

describe('FastQuery — settlement', () => {
  it('handleError rejects immediately; a later ReadyForQuery neither settles again nor throws', async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);
    query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23, format: 'text' }] });
    // Partial row before the error — discarded by the rejection.
    query.handleDataRow({ fields: ['1'] });

    const boom = new Error('backend boom');
    query.handleError(boom);

    // Settled before any ReadyForQuery (parity with stock pg: fatal
    // connection errors never deliver an RFQ).
    await expect(query.promise).rejects.toBe(boom);
    expect(() => query.handleReadyForQuery()).not.toThrow();
    await expect(query.promise).rejects.toBe(boom);
  });
});

describe('FastQuery — NoData sentinel', () => {
  it('caches an empty fields array at settlement so the next execution skips describe', async () => {
    const cache = new Map<string, FastQueryField[]>();
    const text = 'INSERT INTO t (n) VALUES ($1)';
    const types = makeTypes();

    // Cold execution: describe is sent, but the statement has no result
    // columns — NoData, no handleRowDescription before ReadyForQuery.
    const first = new FastQuery({ name: 'q1', text, values: [1], types }, cache);
    const connA = createMockConnection();
    expect(first.submit(connA)).toBeNull();
    expect(connA.methods()).toContain('describe');
    first.handleCommandComplete({ text: 'INSERT 0 1' });
    first.handleReadyForQuery();
    await expect(first.promise).resolves.toMatchObject({ rows: [], fields: [] });
    expect(cache.get('q1')).toEqual([]);

    // Warm execution: the empty-fields sentinel takes the no-describe path.
    const second = new FastQuery({ name: 'q1', text, values: [2], types }, cache);
    const connB = createMockConnection({ parsedStatements: { q1: text } });
    expect(second.submit(connB)).toBeNull();
    expect(connB.methods()).toEqual(['bind', 'execute', 'sync']);
    second.handleCommandComplete({ text: 'INSERT 0 1' });
    second.handleReadyForQuery();
    await expect(second.promise).resolves.toMatchObject({ rows: [], fields: [] });
  });
});

describe('FastQuery — handleEmptyQuery', () => {
  it('resolves with empty rows at ReadyForQuery', async () => {
    const { query } = buildQuery({ text: '' });
    const conn = createMockConnection();
    query.submit(conn);

    query.handleEmptyQuery();
    query.handleReadyForQuery();

    await expect(query.promise).resolves.toMatchObject({ rows: [], fields: [] });
  });
});

describe('FastQuery — handlePortalSuspended', () => {
  it('buffers an error that rejects the promise at settlement', async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);

    // Defensive branch: FastQuery always executes with rows: 0, so a
    // PortalSuspended must never arrive — invoked directly for coverage.
    query.handlePortalSuspended();
    query.handleReadyForQuery();

    await expect(query.promise).rejects.toBeInstanceOf(Error);
  });
});

describe('FastQuery — COPY handling', () => {
  it('handleCopyInResponse sends CopyFail and the query still settles exactly once', async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);

    query.handleCopyInResponse(conn);

    expect(conn.methods().at(-1)).toBe('sendCopyFail');
    expect(typeof conn.argOf('sendCopyFail')).toBe('string');

    const boom = new Error('COPY terminated');
    query.handleError(boom);
    await expect(query.promise).rejects.toBe(boom);
    expect(() => query.handleReadyForQuery()).not.toThrow();
  });

  it('handleCopyData is a no-op', async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);
    const callsBefore = conn.calls.length;

    query.handleCopyData({ chunk: Buffer.from('ignored') });

    expect(conn.calls.length).toBe(callsBefore);
    // The query still completes normally afterwards.
    query.handleCommandComplete({ text: 'SELECT 0' });
    query.handleReadyForQuery();
    await expect(query.promise).resolves.toMatchObject({ rows: [] });
  });
});

// Tripwire for pg version bumps: FastQuery rides pg internals that are not
// part of the documented API. If any assertion here fails after a pg
// upgrade, FastQuery must be re-validated against the new pg release.
describe('pg seam contract', () => {
  it('pg/lib/utils exposes prepareValue', () => {
    expect(typeof pgUtils.prepareValue).toBe('function');
  });

  it('an unconnected pg.Client exposes the extended-protocol connection seam', () => {
    const client = new pg.Client({ host: 'localhost' });
    const connection = client.connection as unknown as Record<string, unknown>;

    for (const method of ['parse', 'bind', 'execute', 'sync', 'describe'] as const) {
      expect(typeof connection[method], `connection.${method}`).toBe('function');
    }
    expect(typeof connection.parsedStatements).toBe('object');
    expect(connection.parsedStatements).not.toBeNull();
  });
});
