import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertPgInternals, getPgActiveQuery } from './pg-internals.ts';

type Features = { fastQueryPath: boolean; statementCaching: boolean };

const ACTIVE_QUERY =
  'client._getActiveQuery() (pg >= 8.17) or an own client.queryQueue (pg <= 8.16)';
const PARSED_STATEMENTS =
  'client.connection.parsedStatements (extensible plain/null-prototype property record)';
const FAST_QUERY_SEAMS = [
  ['parse', 'client.connection.parse()', undefined],
  ['bind', 'client.connection.bind()', undefined],
  ['describe', 'client.connection.describe()', undefined],
  ['execute', 'client.connection.execute()', undefined],
  ['sync', 'client.connection.sync()', undefined],
  ['sendCopyFail', 'client.connection.sendCopyFail()', undefined],
  ['stream', 'client.connection.stream (usable object)', null],
] as const;
const CLOSE = 'client.connection.close()';
const CONNECTION_PARAMETERS = 'client.connectionParameters (object with an own query_timeout)';

const seamError = (invalid: readonly string[]): Error =>
  new Error(
    [
      'Unsupported pg internals: prisma-pglite-bridge relies on undocumented pg 8.x private state.',
      'Make sure prisma-pglite-bridge and @prisma/adapter-pg use one deduplicated pg 8.x installation.',
      'pg 8.16.3 is the oldest verified-compatible release; older 8.x minors may predate these internals.',
      'Missing or incompatible internals:',
      ...invalid.map((item) => `- ${item}`),
    ].join('\n'),
  );

type ConnectionFixture = {
  parsedStatements: unknown;
  stream: unknown;
  parse: unknown;
  bind: unknown;
  describe: unknown;
  execute: unknown;
  sync: unknown;
  sendCopyFail: unknown;
  close: unknown;
};

const method = (): void => {};

const connectionFixture = (): ConnectionFixture => ({
  parsedStatements: {},
  stream: {},
  parse: method,
  bind: method,
  describe: method,
  execute: method,
  sync: method,
  sendCopyFail: method,
  close: method,
});

const clientFixture = (
  active: Record<string, unknown> = { _getActiveQuery: method },
  connection: Partial<ConnectionFixture> = {},
  connectionParameters: unknown = { query_timeout: false },
): pg.Client =>
  ({
    ...active,
    connection: { ...connectionFixture(), ...connection },
    connectionParameters,
  }) as unknown as pg.Client;

const noFeatures: Features = { fastQueryPath: false, statementCaching: false };
const allFeatures: Features = { fastQueryPath: true, statementCaching: true };

describe('assertPgInternals', () => {
  it('accepts the actual installed pg Client with every feature enabled', () => {
    expect(() =>
      assertPgInternals(new pg.Client({ host: 'localhost' }), allFeatures),
    ).not.toThrow();
  });

  it.each([
    ['modern accessor (pg >= 8.17)', { _getActiveQuery: method }],
    // Construction-accurate pg <= 8.16 client: the constructor initializes an
    // own queryQueue array, while activeQuery is a plain field that first
    // materializes during query processing — absent here, like _activeQuery
    // and _getActiveQuery, which pg <= 8.16 never had.
    ['own-queryQueue (pg <= 8.16)', { queryQueue: [] }],
  ])('accepts the %s active-query branch', (_name, active) => {
    expect(() => assertPgInternals(clientFixture(active), noFeatures)).not.toThrow();
  });

  it('rejects a client with neither _getActiveQuery nor an own queryQueue', () => {
    expect(() => assertPgInternals(clientFixture({}), noFeatures)).toThrowError(
      seamError([ACTIVE_QUERY]),
    );
  });

  it('rejects a bare _activeQuery field without an own queryQueue', () => {
    // No pg release ever shipped this shape: pg <= 8.16 had no _activeQuery
    // at all, and pg >= 8.17 pairs it with _getActiveQuery(). Accepting it
    // was a guard bug, not compatibility.
    expect(() => assertPgInternals(clientFixture({ _activeQuery: null }), noFeatures)).toThrowError(
      seamError([ACTIVE_QUERY]),
    );
  });

  it('rejects a prototype queryQueue accessor without ever reading it', () => {
    // pg >= 8.17 moved queryQueue behind a DEPRECATED prototype accessor that
    // fires a deprecation notice on every read. The guard must check for an
    // own property (hasOwn), not `in`, and must never touch the accessor —
    // the throwing getter proves both at once.
    const deprecatedPrototype = Object.create(Object.prototype, {
      queryQueue: {
        get: (): never => {
          throw new Error('deprecated queryQueue accessor must not be read');
        },
      },
    }) as object;
    const client = Object.assign(Object.create(deprecatedPrototype) as Record<string, unknown>, {
      connection: connectionFixture(),
      connectionParameters: { query_timeout: false },
    }) as unknown as pg.Client;

    expect(() => assertPgInternals(client, noFeatures)).toThrowError(seamError([ACTIVE_QUERY]));
  });

  it.each([
    ['ordinary object', () => ({})],
    ['null-prototype object', () => Object.create(null) as Record<string, unknown>],
  ])('accepts an extensible %s for parsedStatements', (_name, record) => {
    expect(() =>
      assertPgInternals(clientFixture(undefined, { parsedStatements: record() }), noFeatures),
    ).not.toThrow();
  });

  it.each([
    ['Map', () => new Map<string, string>()],
    ['array', () => []],
    ['null', () => null],
    ['nonextensible object', () => Object.preventExtensions({})],
  ])('rejects a %s for parsedStatements', (_name, record) => {
    expect(() =>
      assertPgInternals(clientFixture(undefined, { parsedStatements: record() }), noFeatures),
    ).toThrowError(seamError([PARSED_STATEMENTS]));
  });

  it('does not require fast-query seams when the fast path is disabled', () => {
    expect(() =>
      assertPgInternals(
        clientFixture(undefined, {
          parse: undefined,
          bind: undefined,
          describe: undefined,
          execute: undefined,
          sync: undefined,
          sendCopyFail: undefined,
          stream: null,
        }),
        noFeatures,
      ),
    ).not.toThrow();
  });

  it.each(
    FAST_QUERY_SEAMS,
  )('requires connection.%s when the fast path is enabled', (property, label, invalid) => {
    expect(() =>
      assertPgInternals(clientFixture(undefined, { [property]: invalid }), {
        fastQueryPath: true,
        statementCaching: false,
      }),
    ).toThrowError(seamError([label]));
  });

  it('rejects a callable connection.stream when the fast path is enabled', () => {
    expect(() =>
      assertPgInternals(clientFixture(undefined, { stream: method }), {
        fastQueryPath: true,
        statementCaching: false,
      }),
    ).toThrowError(seamError(['client.connection.stream (usable object)']));
  });

  it('does not require connection.close when statement caching is disabled', () => {
    expect(() =>
      assertPgInternals(clientFixture(undefined, { close: undefined }), noFeatures),
    ).not.toThrow();
  });

  it('requires connection.close when statement caching is enabled', () => {
    expect(() =>
      assertPgInternals(clientFixture(undefined, { close: undefined }), {
        fastQueryPath: false,
        statementCaching: true,
      }),
    ).toThrowError(seamError([CLOSE]));
  });

  // connectionParameters checks — tests 1–3 are red until the guard lands

  it('rejects a client that has no connectionParameters property', () => {
    // clientFixture third arg undefined omits the field entirely so it does not appear on the object
    const client: pg.Client = {
      _getActiveQuery: method,
      connection: connectionFixture(),
      // connectionParameters intentionally absent
    } as unknown as pg.Client;
    expect(() => assertPgInternals(client, noFeatures)).toThrowError(
      seamError([CONNECTION_PARAMETERS]),
    );
  });

  it('rejects connectionParameters: null', () => {
    expect(() => assertPgInternals(clientFixture(undefined, {}, null), noFeatures)).toThrowError(
      seamError([CONNECTION_PARAMETERS]),
    );
  });

  it('rejects connectionParameters with query_timeout on the prototype only (not an own property)', () => {
    const inherited = Object.create({ query_timeout: false }) as Record<string, unknown>;
    expect(() =>
      assertPgInternals(clientFixture(undefined, {}, inherited), noFeatures),
    ).toThrowError(seamError([CONNECTION_PARAMETERS]));
  });

  it('accepts connectionParameters: { query_timeout: false } (pg default value)', () => {
    expect(() =>
      assertPgInternals(clientFixture(undefined, {}, { query_timeout: false }), noFeatures),
    ).not.toThrow();
  });

  it('reports every incompatibility once in deterministic dependency order', () => {
    const connection = Object.fromEntries(
      FAST_QUERY_SEAMS.map(([property, _label, invalid]) => [property, invalid]),
    );
    const client = clientFixture(
      {},
      {
        parsedStatements: new Map(),
        ...connection,
        close: undefined,
      },
    );

    expect(() => assertPgInternals(client, allFeatures)).toThrowError(
      seamError([
        ACTIVE_QUERY,
        PARSED_STATEMENTS,
        ...FAST_QUERY_SEAMS.map(([, label]) => label),
        CLOSE,
      ]),
    );
  });

  // pg seam contract — pins the real pg runtime shape the guard assumes
  it('pg seam contract: new pg.Client() has a non-null connectionParameters object with own query_timeout', () => {
    const client = new pg.Client({ host: 'localhost' });
    expect(client.connectionParameters).not.toBeNull();
    expect(typeof client.connectionParameters).toBe('object');
    expect(Object.hasOwn(client.connectionParameters as object, 'query_timeout')).toBe(true);
  });
});

describe('getPgActiveQuery', () => {
  it('returns _getActiveQuery() on pg >= 8.17 without reading the deprecated activeQuery getter', () => {
    // On pg >= 8.17 the activeQuery accessor fires a deprecation notice on
    // every read — the throwing getter proves the helper never touches it.
    const sentinel = { text: 'SELECT 1' };
    const client = Object.defineProperty({ _getActiveQuery: () => sentinel }, 'activeQuery', {
      get: (): never => {
        throw new Error('deprecated activeQuery getter must not be read');
      },
    }) as unknown as pg.Client;

    expect(getPgActiveQuery(client)).toBe(sentinel);
  });

  it('falls back to the plain activeQuery field on pg <= 8.16 once query processing sets it', () => {
    const sentinel = { text: 'SELECT 1' };
    const client = { queryQueue: [], activeQuery: sentinel } as unknown as pg.Client;

    expect(getPgActiveQuery(client)).toBe(sentinel);
  });

  it('returns undefined on a freshly constructed pg <= 8.16 client with no active query yet', () => {
    const client = { queryQueue: [] } as unknown as pg.Client;

    expect(getPgActiveQuery(client)).toBeUndefined();
  });
});
