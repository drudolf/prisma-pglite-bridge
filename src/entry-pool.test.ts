/**
 * Unit tests for src/entry-pool.ts — the curated Prisma-free subpath entry.
 *
 * These tests are RED until src/entry-pool.ts is created. The entry must
 * re-export exactly eight runtime values (identity-equal to the barrel's
 * exports) plus a fixed set of type-only exports, and nothing else — the
 * point of the subpath is that importing it never pulls @prisma/* code, so
 * any extra runtime key is a surface leak.
 */

import { describe, expect, it } from 'vitest';
import type {
  LockWaitEvent,
  PGliteDuplexOptions,
  PgBridgeErrorCode,
  PgBridgePoolOptions,
  QueryEvent,
  Stats,
  StatsBasic,
  StatsFull,
  StatsLevel,
  SyncToFsMode,
} from './entry-pool.ts';
// These imports fail (module missing) until entry-pool.ts is created — expected.
import * as entry from './entry-pool.ts';
import * as barrel from './index.ts';

/**
 * The complete runtime surface of the pool entry, pre-sorted in default
 * string order. Type-only exports leave no runtime key, so Object.keys of
 * the namespace must equal exactly this list.
 */
const expectedValueExports = [
  'LOCK_WAIT_CHANNEL',
  'PGliteDuplex',
  'PgBridgeError',
  'PgBridgePool',
  'QUERY_CHANNEL',
  'SessionLock',
  'TRAIL_FORMAT_VERSION',
  'formatQueryTrail',
] as const;

describe('entry-pool runtime export surface', () => {
  it('exports exactly the eight curated runtime values and nothing else', () => {
    expect(Object.keys(entry).sort()).toEqual([...expectedValueExports]);
  });

  it('re-exports every runtime value by identity from the barrel', () => {
    // Plain-object copies keep the loop free of dynamic namespace access
    // (Biome noDynamicNamespaceImportAccess) while preserving identity.
    const entryExports: Record<string, unknown> = { ...entry };
    const barrelExports: Record<string, unknown> = { ...barrel };
    for (const name of expectedValueExports) {
      expect(entryExports[name]).toBeDefined();
      expect(entryExports[name]).toBe(barrelExports[name]);
    }
  });
});

describe('entry-pool type-only export surface', () => {
  it('exposes the curated types (compile-time pin, no runtime keys)', () => {
    // A known-valid PgBridgeErrorCode literal must be assignable.
    const code: PgBridgeErrorCode = 'POOL_NOT_IDLE';
    // Referencing each remaining type in a tuple pins its existence at
    // compile time; the tuple's literal length is the only runtime residue.
    type TypeOnlyExports = [
      LockWaitEvent,
      PGliteDuplexOptions,
      PgBridgePoolOptions,
      QueryEvent,
      Stats,
      StatsBasic,
      StatsFull,
      StatsLevel,
      SyncToFsMode,
    ];
    const typeOnlyExportCount: TypeOnlyExports['length'] = 9;
    expect(code).toBe('POOL_NOT_IDLE');
    expect(typeOnlyExportCount).toBe(9);
  });
});
