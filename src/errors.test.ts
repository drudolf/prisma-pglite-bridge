/**
 * Unit tests for src/errors.ts — the PgBridgeError class and PgBridgeErrorCode type.
 *
 * These tests are RED until src/errors.ts is created. Every assertion is a
 * forward-contract pin against the post-implementation surface.
 *
 * Also contains the barrel re-export identity check (Item 3 of the cold-agent
 * brief): { PgBridgeError } from src/index.ts must be the same class as the
 * direct import from src/errors.ts.
 */

import { describe, expect, it } from 'vitest';
// This import will fail (module missing) until errors.ts is created — expected.
import { PgBridgeError } from './errors.ts';

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

  it('message passthrough — err.message equals the constructor argument', () => {
    const msg = 'PGlite instance closed';
    const err = new PgBridgeError('PGLITE_CLOSED', msg);
    expect(err.message).toBe(msg);
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

describe('PgBridgeError barrel re-export identity', () => {
  it('PgBridgeError from src/index.ts is the same class as from src/errors.ts', async () => {
    // Dynamic import to avoid a static import from index.ts adding noise to
    // other failures — this test can only go green once both the module and
    // the barrel export exist.
    const { PgBridgeError: BarrelExport } = await import('./index.ts');
    expect(BarrelExport).toBe(PgBridgeError);
  });
});
