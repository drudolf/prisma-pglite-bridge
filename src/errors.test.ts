/**
 * Unit tests for src/errors.ts — the PgBridgeError class and PgBridgeErrorCode type.
 *
 * Every assertion is a contract pin against the public surface, including
 * the docs tail appended to every message and the `docs` property.
 *
 * Also contains the barrel re-export identity check (Item 3 of the cold-agent
 * brief): { PgBridgeError } from src/index.ts must be the same class as the
 * direct import from src/errors.ts.
 */

import { describe, expect, it } from 'vitest';
import { errorDocsPointer, PgBridgeError, TROUBLESHOOTING_DOC, withDocsTail } from './errors.ts';

describe('PgBridgeError class', () => {
  it('is an instance of Error', () => {
    const err = new PgBridgeError('UNSUPPORTED_PG_INTERNALS', 'test message');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of PgBridgeError', () => {
    const err = new PgBridgeError('BRIDGE_OPTIONS_REQUIRED', 'test message');
    expect(err).toBeInstanceOf(PgBridgeError);
  });

  it('has name === "PgBridgeError"', () => {
    const err = new PgBridgeError('POOL_NOT_IDLE', 'test message');
    expect(err.name).toBe('PgBridgeError');
  });

  it('name is an own instance property (not only on the prototype)', () => {
    const err = new PgBridgeError('INVALID_STATS_LEVEL', 'test message');
    expect(Object.hasOwn(err, 'name')).toBe(true);
  });

  it('name survives after construction (the override readonly field is set)', () => {
    const err = new PgBridgeError('SERVER_CLOSED', 'msg');
    // Access twice to rule out a getter that re-reads prototype
    const first = err.name;
    const second = err.name;
    expect(first).toBe('PgBridgeError');
    expect(second).toBe('PgBridgeError');
  });

  it('code matches the constructor argument', () => {
    const err = new PgBridgeError('SERVER_PGLITE_CLOSED', 'test message');
    expect(err.code).toBe('SERVER_PGLITE_CLOSED');
  });

  it('code is an own instance property', () => {
    const err = new PgBridgeError('PGLITE_CLOSED', 'msg');
    expect(Object.hasOwn(err, 'code')).toBe(true);
  });

  it('message is the constructor argument plus the docs tail', () => {
    const msg = 'PGlite instance closed';
    const err = new PgBridgeError('PGLITE_CLOSED', msg);
    expect(err.message).toBe(withDocsTail(msg, errorDocsPointer('PGLITE_CLOSED')));
  });

  it('docs equals errorDocsPointer(code) and is package-relative', () => {
    const err = new PgBridgeError('POOL_NOT_IDLE', 'msg');
    expect(err.docs).toBe(errorDocsPointer('POOL_NOT_IDLE'));
    expect(err.docs.startsWith('prisma-pglite-bridge/docs/troubleshooting.md#')).toBe(true);
    expect(Object.hasOwn(err, 'docs')).toBe(true);
  });

  it('single-line message: exact tail format, one space before the pointer', () => {
    const err = new PgBridgeError('SERVER_CLOSED', 'Server is closed.');
    expect(err.message).toBe(
      'Server is closed. (docs: prisma-pglite-bridge/docs/troubleshooting.md#server_closed)',
    );
  });

  it('multi-line message: the tail lands on its own last line', () => {
    const body = 'Missing internals:\n- a\n- b';
    const err = new PgBridgeError('UNSUPPORTED_PG_INTERNALS', body);
    const lines = err.message.split('\n');
    expect(lines.at(-1)).toBe(
      '(docs: prisma-pglite-bridge/docs/troubleshooting.md#unsupported_pg_internals)',
    );
    expect(lines.at(-1)?.startsWith('(docs: ')).toBe(true);
    expect(lines.slice(0, -1).join('\n')).toBe(body);
  });

  it('cause passthrough via ErrorOptions', () => {
    const cause = new Error('original cause');
    const err = new PgBridgeError('MIGRATIONS_APPLY_FAILED', 'wrapper message', { cause });
    expect(err.cause).toBe(cause);
  });

  it('cause is undefined when no options are provided', () => {
    const err = new PgBridgeError('PGLITE_NOT_READY', 'msg');
    expect(err.cause).toBeUndefined();
  });

  it('supports all PgBridgeErrorCode values without TS error', () => {
    const codes = [
      'UNSUPPORTED_PG_INTERNALS',
      'BRIDGE_OPTIONS_REQUIRED',
      'POOL_NOT_IDLE',
      'INVALID_STATS_LEVEL',
      'SERVER_CLOSED',
      'SERVER_PGLITE_CLOSED',
      'PGLITE_CLOSED',
      'PGLITE_NOT_READY',
      'MIGRATIONS_UNAVAILABLE',
      'MIGRATIONS_APPLY_FAILED',
      'SNAPSHOT_INVALID',
    ] as const;
    for (const code of codes) {
      const err = new PgBridgeError(code, 'msg');
      expect(err.code).toBe(code);
    }
  });
});

describe('docs pointer helpers', () => {
  it('TROUBLESHOOTING_DOC is the package-relative guide path', () => {
    expect(TROUBLESHOOTING_DOC).toBe('prisma-pglite-bridge/docs/troubleshooting.md');
  });

  it('errorDocsPointer lowercases the code as the anchor', () => {
    expect(errorDocsPointer('MIGRATIONS_APPLY_FAILED')).toBe(
      `${TROUBLESHOOTING_DOC}#migrations_apply_failed`,
    );
  });

  it('withDocsTail separates with a space for single-line and a newline for multi-line', () => {
    expect(withDocsTail('one line', 'p')).toBe('one line (docs: p)');
    expect(withDocsTail('two\nlines', 'p')).toBe('two\nlines\n(docs: p)');
  });
});

describe('PgBridgeError barrel re-export identity', () => {
  it('PgBridgeError from src/index.ts is the same class as from src/errors.ts', async () => {
    // Dynamic import to avoid a static import from index.ts adding noise to
    // other failures — this test can only go green once both the module and
    // the barrel export exist.
    const { PgBridgeError: BarrelExport } = await import('./index.ts');
    expect(BarrelExport).toBe(PgBridgeError);
  });
});
