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
import type { TypesLike } from './fast-array-parsers.ts';
import { FastQuery, type FastQueryField } from './fast-query.ts';
import { PgBridgePool } from './index.ts';

type ProtocolCall = { method: string; arg: unknown };

// The mock plays pg's Connection (so it satisfies FastQuery.submit's typed
// param) plus the recording instrumentation the assertions read.
type MockConnection = pg.Connection & {
  calls: ProtocolCall[];
  methods: () => string[];
  argOf: (method: string) => unknown;
  // Not on pg's public Connection type; handleCopyInResponse reads it.
  sendCopyFail: (msg: string) => void;
};

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
  } as unknown as MockConnection;
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

  it('turns a warm-path parser-resolution throw into a rejection and recovery Sync', async () => {
    const boom = new Error('parser resolver boom');
    const text = 'SELECT n FROM t';
    const cache = new Map<string, FastQueryField[]>([['q1', [{ name: 'n', dataTypeID: 23 }]]]);
    const types = makeTypes(() => {
      throw boom;
    });
    const conn = createMockConnection({ parsedStatements: { q1: text } });
    const { query } = buildQuery({ text, cache, types });

    // Stock pg contains parser setup failures inside the query. FastQuery must
    // likewise recover the already-sent Bind with Sync rather than throwing
    // out of Client._pulseQueryQueue and wedging the client. The rejection
    // arrives at ReadyForQuery, not inside submit — premature settlement
    // clears the submission chain while pg's active-query slot still holds
    // this query, and a release() in that window skips the
    // abandoned-transaction cleanup (probe-verified leak).
    expect(query.submit(conn)).toBeNull();
    expect(conn.methods()).toEqual(['bind', 'sync']);
    query.handleReadyForQuery();
    await expect(query.promise).rejects.toBe(boom);
  });

  it('normalizes a non-Error warm-path parser-resolution throw into an Error rejection', async () => {
    // The recovery arm must not assume caller code throws Error instances —
    // a string throw still settles as a real Error (pg's rejection contract).
    const text = 'SELECT n FROM t';
    const cache = new Map<string, FastQueryField[]>([['q1', [{ name: 'n', dataTypeID: 23 }]]]);
    const types = makeTypes(() => {
      throw 'parser resolver string boom';
    });
    const conn = createMockConnection({ parsedStatements: { q1: text } });
    const { query } = buildQuery({ text, cache, types });

    expect(query.submit(conn)).toBeNull();
    expect(conn.methods()).toEqual(['bind', 'sync']);
    query.handleReadyForQuery();
    await expect(query.promise).rejects.toBeInstanceOf(Error);
    await expect(query.promise).rejects.toThrow('parser resolver string boom');
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

  it('buffers a parser-resolution failure and rejects at ReadyForQuery', async () => {
    const boom = new Error('parser resolver boom');
    const types = makeTypes(() => {
      throw boom;
    });
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);

    // RowDescription is delivered from pg's connection event handler. A throw
    // here escapes as uncaughtException; it must instead become the query's
    // ordinary rejection once the protocol reaches ReadyForQuery.
    expect(() =>
      query.handleRowDescription({
        fields: [{ name: 'n', dataTypeID: 23, format: 'text' }],
      }),
    ).not.toThrow();
    query.handleReadyForQuery();

    await expect(query.promise).rejects.toBe(boom);
  });

  it('keeps the first buffered error when parser resolution also fails (first error wins)', async () => {
    const boom = new Error('parser resolver boom');
    const types = makeTypes(() => {
      throw boom;
    });
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);

    // An unexpected PortalSuspended buffered an error first; the later
    // parser-resolution failure must not overwrite it.
    query.handlePortalSuspended();
    expect(() =>
      query.handleRowDescription({
        fields: [{ name: 'n', dataTypeID: 23, format: 'text' }],
      }),
    ).not.toThrow();
    query.handleReadyForQuery();

    await expect(query.promise).rejects.toThrow(/unexpected PortalSuspended/);
  });

  it('normalizes a non-Error parser-resolution throw into an Error rejection', async () => {
    const types = makeTypes(() => {
      throw 'cold string boom';
    });
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);

    expect(() =>
      query.handleRowDescription({
        fields: [{ name: 'n', dataTypeID: 23, format: 'text' }],
      }),
    ).not.toThrow();
    query.handleReadyForQuery();

    await expect(query.promise).rejects.toBeInstanceOf(Error);
    await expect(query.promise).rejects.toThrow('cold string boom');
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

  it('buffers a row-parser failure, discards partial rows, and rejects at ReadyForQuery', async () => {
    const boom = new Error('row parser boom');
    const types = makeTypes(() => (raw) => {
      if (raw === 'bad') throw boom;
      return Number(raw);
    });
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);
    query.handleRowDescription({
      fields: [{ name: 'n', dataTypeID: 23, format: 'text' }],
    });
    query.handleDataRow({ fields: ['1'] });

    // Stock pg catches type-parser failures in handleDataRow. FastQuery must
    // not let one escape the connection's dataRow event as uncaughtException.
    expect(() => query.handleDataRow({ fields: ['bad'] })).not.toThrow();
    query.handleReadyForQuery();

    await expect(query.promise).rejects.toBe(boom);
  });

  it('drops a straggler row after a fatal handleError without parsing or resurrecting the query', async () => {
    const parser = vi.fn((raw: string) => Number(raw));
    const types = makeTypes(() => parser);
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);
    query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23, format: 'text' }] });

    const fatal = new Error('fatal connection boom');
    query.handleError(fatal);

    // A DataRow already in the pipe when a fatal error settled the query is
    // still delivered — pg dispatches connection events unconditionally. It
    // must be dropped silently: no throw out of the dataRow event, no parser
    // run, and no resurrection of the already-settled rejection.
    expect(() => query.handleDataRow({ fields: ['7'] })).not.toThrow();
    expect(parser).not.toHaveBeenCalled();

    await expect(query.promise).rejects.toBe(fatal);
  });

  it('skips rows arriving after a buffered row-parser failure without invoking the parser', async () => {
    const boom = new Error('row parser boom');
    const parser = vi.fn((raw: string): number => {
      if (raw === 'bad') throw boom;
      return Number(raw);
    });
    const types = makeTypes(() => parser);
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);
    query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23, format: 'text' }] });

    query.handleDataRow({ fields: ['1'] });
    expect(() => query.handleDataRow({ fields: ['bad'] })).not.toThrow();

    // Rows AFTER the buffered failure must be skipped WITHOUT running their
    // parsers: the result is already doomed, and a second parser throw here
    // would escape the connection's dataRow event as uncaughtException.
    const parserCallsAtFailure = parser.mock.calls.length;
    expect(() => query.handleDataRow({ fields: ['2'] })).not.toThrow();
    expect(parser.mock.calls.length).toBe(parserCallsAtFailure);

    query.handleReadyForQuery();
    await expect(query.promise).rejects.toBe(boom);
  });

  it('normalizes a non-Error row-parser throw into an Error rejection', async () => {
    const types = makeTypes(() => (raw) => {
      if (raw === 'bad') throw 'row string boom';
      return Number(raw);
    });
    const { query } = buildQuery({ types });
    const conn = createMockConnection();
    query.submit(conn);
    query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23, format: 'text' }] });

    expect(() => query.handleDataRow({ fields: ['bad'] })).not.toThrow();
    query.handleReadyForQuery();

    await expect(query.promise).rejects.toBeInstanceOf(Error);
    await expect(query.promise).rejects.toThrow('row string boom');
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

  // STOCK PARITY: pg's Query swaps _canceledDueToError (the buffered
  // row-parser failure) in for the fatal error before invoking its
  // callback — the caller sees the root cause, not the teardown.
  it('prefers a buffered row-parser failure over a later fatal error', async () => {
    const { query } = buildQuery({
      types: makeTypes(() => () => {
        throw new Error('row parser boom');
      }),
    });
    query.handleRowDescription({ fields: [{ name: 'n', dataTypeID: 23, format: 'text' }] });
    query.handleDataRow({ fields: ['1'] });

    query.handleError(new Error('connection terminated'));

    await expect(query.promise).rejects.toThrow('row parser boom');
  });

  // MODULE DISCIPLINE (no stock counterpart — stock pg wedges on a bind
  // throw): first-error-wins holds uniformly across bufferedError
  // sources, not just the row-parser case stock pg arbitrates.
  it('prefers a buffered bind failure over a later fatal error', async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    conn.bind = () => {
      throw new Error('bind boom');
    };

    expect(query.submit(conn)).toBeNull();
    query.handleError(new Error('connection terminated'));

    await expect(query.promise).rejects.toThrow('bind boom');
  });

  // Uniform-rule pin for the documented-unreachable source: the
  // PortalSuspended sentinel names a protocol violation that preceded
  // the fatal error, so it stays the rejection reason.
  it('prefers the buffered PortalSuspended sentinel over a later fatal error', async () => {
    const { query } = buildQuery();

    query.handlePortalSuspended();
    query.handleError(new Error('connection terminated'));

    await expect(query.promise).rejects.toThrow('unexpected PortalSuspended');
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

// Regression spec for the fast-path bind-throw wedge: pg-protocol's
// serializer.bind applies prepareValue synchronously and THROWS on
// unserializable values (circular structures, a throwing toPostgres).
// Without a catch around connection.bind in FastQuery.submit, the throw
// escapes pg's _pulseQueryQueue with readyForQuery still false and
// activeQuery stuck — every later query on that client queues forever.
// Post-fix contract: the query rejects with an Error, the SAME client stays
// usable, and a retry of the same name/text parse-skips the statement the
// failed attempt already parsed (deliberate no-Close divergence from stock
// pg). Integration-style on a real PgBridgePool, like src/pool/index.test.ts.
describe('FastQuery — bind-throw recovery on a live client', () => {
  // A pre-fix wedge leaves follow-up queries queued forever: bound them so
  // the failure surfaces in ~1.5 s instead of eating the 30 s suite timeout.
  const bounded = <T>(promise: Promise<T>, label: string): Promise<T> => {
    // On a wedged client the raced-away promise only settles when pool
    // teardown force-destroys the connection ("Connection terminated") —
    // swallow that late rejection so it cannot surface as an unhandled
    // error after the race already failed the test.
    promise.catch(() => {});
    return Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(label));
        }, 1_500).unref();
      }),
    ]);
  };

  const circularValue = (): Record<string, unknown> => {
    const value: Record<string, unknown> = {};
    value.self = value;
    return value;
  };

  it('rejects an unserializable fast-path value and keeps the same client usable', async () => {
    const pool = new PgBridgePool();
    // Same-client identity is the point (condition): check the client out
    // explicitly so the follow-up cannot vacuously hit a fresh client.
    const client = await pool.connect();
    try {
      await expect(
        client.query({
          name: 'fq_bind_recover',
          text: 'SELECT $1::int AS n',
          values: [circularValue()],
          rowMode: 'array' as const,
          types: pg.types,
        }),
      ).rejects.toThrow(/circular/i);

      // Pre-fix the client is wedged (readyForQuery stuck false) and this
      // never settles.
      const followUp = await bounded(
        client.query('SELECT 1 AS ok'),
        'follow-up query never settled — client wedged by the bind throw',
      );
      expect(followUp.rows).toEqual([{ ok: 1 }]);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('retry with valid values reuses the statement parsed by the failed attempt', async () => {
    const parseSpy = vi.spyOn(pg.Connection.prototype, 'parse');
    const pool = new PgBridgePool();
    const client = await pool.connect();
    try {
      // Syntactically VALID SQL (condition): invalid text would yield an
      // ErrorResponse with no ParseComplete, never populating
      // parsedStatements — the no-Close rationale would go unexercised.
      const shape = {
        name: 'fq_bind_retry',
        text: 'SELECT $1::int AS n',
        rowMode: 'array' as const,
        types: pg.types,
      };
      await expect(client.query({ ...shape, values: [circularValue()] })).rejects.toThrow(
        /circular/i,
      );

      // The failed attempt already parsed the statement (ParseComplete
      // recorded it in parsedStatements), so the retry must send NO fresh
      // Parse and succeed. A stock-pg-style Close after the error would
      // evict PGlite's copy while pg still parse-skips → 26000 here.
      parseSpy.mockClear();
      const retry = await bounded(
        client.query({ ...shape, values: [7] }),
        'retry never settled — client wedged by the bind throw',
      );
      expect(retry.rows).toEqual([[7]]);
      expect(parseSpy).not.toHaveBeenCalled();
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('wraps a non-Error throw from a toPostgres serializer into an Error rejection', async () => {
    const pool = new PgBridgePool();
    try {
      const rejection = await pool
        .query({
          name: 'fq_bind_wrap',
          text: 'SELECT $1::int AS n',
          values: [
            {
              toPostgres: (): never => {
                // A non-Error throw is the point: it pins the String(err)
                // wrap branch of the recovery path.
                throw 'boom';
              },
            },
          ],
          rowMode: 'array' as const,
          types: pg.types,
        })
        .then(
          () => null,
          (err: unknown) => err,
        );

      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toBe('boom');
    } finally {
      await pool.end();
    }
  });
});

// Integration spec for the parser-failure recovery paths on a live client.
// The unit tests above pin the protocol mechanics (recovery Sync, buffered
// rejection at ReadyForQuery, straggler skipping); these three prove the
// consequence that matters: a throwing types.getTypeParser — or a throwing
// resolved row parser — rejects only ITS query, and the SAME client answers
// the next one. Real pools, like the bind-throw describe above.
describe('FastQuery — parser-failure recovery keeps the client live (integration)', () => {
  // Bounded blocked-promise detection (the settledOrPending idiom from
  // index.abandoned-transaction.test.ts): a recovery bug wedges the client
  // and the follow-up never settles — surface that as the 'pending' sentinel
  // in ~1.5 s instead of hanging into the suite timeout. The raced-away
  // promise only settles at pool teardown ("Connection terminated"); swallow
  // that late rejection so it cannot surface as an unhandled error.
  const settledOrPending = <T>(p: Promise<T>, ms: number): Promise<T | 'pending'> => {
    p.catch(() => {});
    return Promise.race([
      p,
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), ms).unref();
      }),
    ]);
  };

  // Minimal user-supplied types objects, adapter-pg shaped. The bridge wraps
  // them with the fast-array wrapper, which DELEGATES to the user
  // getTypeParser for non-array OIDs — so a plain int column reaches these.
  // Same `as unknown as pg.CustomTypesConfig` narrowing precedent as
  // fast-array-parsers.test.ts (@types/pg overload-types getTypeParser).
  const passthroughTypes = (): TypesLike => ({
    getTypeParser: () => (raw: string) => raw,
  });
  const throwingTypes = (boom: Error): TypesLike => ({
    getTypeParser: () => {
      throw boom;
    },
  });

  it('warm path: a parser-resolution throw rejects the query and the same client answers the next one', async () => {
    const boom = new Error('warm parser resolver boom');
    const pool = new PgBridgePool();
    const client = await pool.connect();
    try {
      // First execution (cold) succeeds and caches the fields under this
      // name, so the SECOND execution takes the warm submit path — parsers
      // re-resolved inside submit, after Bind is already on the wire. The
      // throw must be recovered with a Sync (the promise rejecting with the
      // thrown error) instead of escaping _pulseQueryQueue and wedging.
      const shape = {
        name: 'live_w',
        text: 'SELECT 1 AS n',
        rowMode: 'array' as const,
        values: [],
      };
      const first = await client.query({
        ...shape,
        types: passthroughTypes() as unknown as pg.CustomTypesConfig,
      });
      expect(first.rows).toEqual([['1']]);

      await expect(
        client.query({
          ...shape,
          types: throwingTypes(boom) as unknown as pg.CustomTypesConfig,
        }),
      ).rejects.toBe(boom);

      // Same-client liveness is the point: a wedge leaves this 'pending'.
      const followUp = await settledOrPending(client.query('SELECT 1 AS ok'), 1_500);
      expect(followUp).not.toBe('pending');
      if (followUp !== 'pending') expect(followUp.rows).toEqual([{ ok: 1 }]);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('cold path: a parser-resolution throw at RowDescription rejects at RFQ and the client stays live', async () => {
    const boom = new Error('cold parser resolver boom');
    const pool = new PgBridgePool();
    const client = await pool.connect();
    try {
      // Fresh statement name — no cached fields, so getTypeParser throws when
      // RowDescription arrives (inside a connection event handler): the
      // failure is buffered, rows after it are skipped unparsed, and the
      // promise rejects once the protocol reaches ReadyForQuery.
      await expect(
        client.query({
          name: 'live_c',
          text: 'SELECT 1 AS n',
          rowMode: 'array' as const,
          values: [],
          types: throwingTypes(boom) as unknown as pg.CustomTypesConfig,
        }),
      ).rejects.toBe(boom);

      const followUp = await settledOrPending(client.query('SELECT 1 AS ok'), 1_500);
      expect(followUp).not.toBe('pending');
      if (followUp !== 'pending') expect(followUp.rows).toEqual([{ ok: 1 }]);
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('row parser: a throwing resolved parser rejects at RFQ and the client stays live', async () => {
    const boom = new Error('row parser value boom');
    const pool = new PgBridgePool();
    const client = await pool.connect();
    try {
      // getTypeParser RESOLVES fine; the resolved parser throws on the row
      // value, mid-DataRow. The partial row is discarded, the failure is
      // buffered, and the promise rejects at ReadyForQuery — never an
      // uncaughtException out of the connection's dataRow event.
      const rowThrowingTypes: TypesLike = {
        getTypeParser: () => () => {
          throw boom;
        },
      };
      await expect(
        client.query({
          name: 'live_r',
          text: 'SELECT 1 AS n',
          rowMode: 'array' as const,
          values: [],
          types: rowThrowingTypes as unknown as pg.CustomTypesConfig,
        }),
      ).rejects.toBe(boom);

      const followUp = await settledOrPending(client.query('SELECT 1 AS ok'), 1_500);
      expect(followUp).not.toBe('pending');
      if (followUp !== 'pending') expect(followUp.rows).toEqual([{ ok: 1 }]);
    } finally {
      client.release();
      await pool.end();
    }
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

  it('an unconnected pg.Client exposes the COPY-abort and stream-cork seams', () => {
    const client = new pg.Client({ host: 'localhost' });
    const connection = client.connection as unknown as Record<string, unknown>;

    // FastQuery aborts a server-initiated COPY via connection.sendCopyFail.
    expect(typeof connection.sendCopyFail).toBe('function');

    // FastQuery batches its EQP messages inside stream.cork()/uncork().
    // FastQuery optional-chains these, so drift would silently drop the
    // batching rather than throw — this assertion is the only alarm. It is
    // a perf-drift sentinel, not a correctness seam like sendCopyFail: on a
    // future pg where the stream loses cork, delete it deliberately after
    // re-measuring the fast path, not as a green-degradation fix.
    const stream = connection.stream as Record<string, unknown>;
    for (const method of ['cork', 'uncork'] as const) {
      expect(typeof stream[method], `connection.stream.${method}`).toBe('function');
    }
  });

  it('pg.Client exposes the active-query accessor rollbackAbandonedTransaction reads', () => {
    // PgBridgeClient.#pgActiveQuery() reads the in-flight query to skip an
    // undeliverable ROLLBACK on a wedged mid-flight client
    // (rollbackAbandonedTransaction). pg shipped two layouts: pg >= 8.17
    // exposes _getActiveQuery() (pg 8.22 lib/client.js) — preferred, because
    // there the activeQuery accessor is deprecated and fires a notice on
    // every read; pg <= 8.16 had a plain activeQuery field that first
    // materializes during query processing (absent at construction), with
    // the own queryQueue array from the constructor as the guard's marker.
    // The dev pg is >= 8.17, so pin the helper strictly. A correctness seam:
    // if a pg upgrade drops it, that guard silently degrades to a no-op —
    // this is the alarm.
    const client = new pg.Client({ host: 'localhost' });
    const internals = client as unknown as { _getActiveQuery?: unknown };
    expect(typeof internals._getActiveQuery, 'client._getActiveQuery').toBe('function');
  });

  it('an unconnected pg.Client exposes the statement-Close seam', () => {
    // PgBridgeClient.#flushPendingCloses() frees an evicted server-side
    // prepared statement with connection.close({ type: 'S', name }). Drift
    // here throws loudly from the submission point rather than degrading
    // silently, but it is still an untracked pg-internals read — pin it.
    const client = new pg.Client({ host: 'localhost' });
    const connection = client.connection as unknown as Record<string, unknown>;
    expect(typeof connection.close, 'connection.close').toBe('function');
  });
});

describe('mutation-hardening: survivor kills', () => {
  it('anchors the command tag at the start so a leading-space tag yields no command/rowCount', async () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);

    // The ^-anchored COMMAND_TAG must NOT match a tag that does not begin with
    // a letter. Without the anchor a stray 'SELECT' later in the string would
    // be picked up, wrongly setting command/rowCount.
    query.handleCommandComplete({ text: ' SELECT 3' });
    query.handleReadyForQuery();

    await expect(query.promise).resolves.toMatchObject({
      command: null,
      rowCount: null,
      oid: null,
    });
  });

  it('does not clobber cached fields with the NoData sentinel on a warm describe-skipped execution', async () => {
    const text = 'SELECT $1::int AS n';
    const cache = new Map<string, FastQueryField[]>([['q1', [{ name: 'n', dataTypeID: 23 }]]]);
    const conn = createMockConnection({ parsedStatements: { q1: text } });
    const { query } = buildQuery({ text, cache });

    // Warm path: describe is skipped, so describeSent stays false and no
    // RowDescription arrives.
    expect(query.submit(conn)).toBeNull();
    expect(conn.methods()).toEqual(['bind', 'execute', 'sync']);

    query.handleCommandComplete({ text: 'SELECT 1' });
    query.handleReadyForQuery();
    await expect(query.promise).resolves.toBeDefined();

    // The NoData branch (describeSent && !fieldsReceived && !settled) must NOT
    // fire on a warm execution — the cached fields survive untouched.
    expect(cache.get('q1')).toEqual([{ name: 'n', dataTypeID: 23 }]);
  });

  it('aborts a server-initiated COPY with the exact No source stream defined message', () => {
    const { query } = buildQuery();
    const conn = createMockConnection();
    query.submit(conn);

    query.handleCopyInResponse(conn);

    // The abort reason is forwarded to the backend verbatim — pin the message.
    expect(conn.argOf('sendCopyFail')).toBe('No source stream defined');
  });
});
