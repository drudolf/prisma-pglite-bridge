import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { assertPgInternals } from './pg-internals.ts';

type Features = { fastQueryPath: boolean; statementCaching: boolean };

const ACTIVE_QUERY = 'client._getActiveQuery() or client._activeQuery';
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

const seamError = (invalid: readonly string[]): Error =>
  new Error(
    [
      'Unsupported pg internals: prisma-pglite-bridge relies on undocumented pg 8.x private state.',
      'Make sure prisma-pglite-bridge and @prisma/adapter-pg use one deduplicated pg 8.x installation.',
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
): pg.Client =>
  ({
    ...active,
    connection: { ...connectionFixture(), ...connection },
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
    ['modern accessor', { _getActiveQuery: method }],
    ['legacy field', { _activeQuery: null }],
  ])('accepts the %s active-query branch', (_name, active) => {
    expect(() => assertPgInternals(clientFixture(active), noFeatures)).not.toThrow();
  });

  it('rejects a client with neither active-query branch', () => {
    expect(() => assertPgInternals(clientFixture({}), noFeatures)).toThrowError(
      seamError([ACTIVE_QUERY]),
    );
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
});
