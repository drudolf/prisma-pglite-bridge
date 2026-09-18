/**
 * Drift guard for AGENTS.md (shipped in the tarball): every public error code
 * and warning name must appear in it, and it must stay small enough for an
 * agent to ingest whole. The literal lists below are checked against the
 * source unions at compile time, so adding a code without listing it here
 * fails `tsc`, and listing it without documenting it fails this test.
 */
import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PgBridgeErrorCode } from './errors.ts';
import type { BridgeWarningType } from './warnings.ts';

const errorCodes = [
  'UNSUPPORTED_PG_INTERNALS',
  'BRIDGE_OPTIONS_REQUIRED',
  'POOL_NOT_IDLE',
  'INVALID_STATS_LEVEL',
  'SERVER_CLOSED',
  'SERVER_PGLITE_CLOSED',
  'SERVER_NOT_IDLE',
  'PGLITE_CLOSED',
  'PGLITE_NOT_READY',
  'MIGRATIONS_UNAVAILABLE',
  'MIGRATIONS_APPLY_FAILED',
  'MIGRATIONS_HISTORY_INVALID',
  'SNAPSHOT_INVALID',
] as const satisfies readonly PgBridgeErrorCode[];

const warningTypes = [
  'PGliteBridgeAbandonedTransactionWarning',
  'PGliteBridgeSharedInstanceWarning',
  'PGliteBridgeLeakWarning',
] as const satisfies readonly BridgeWarningType[];

// Exhaustiveness: a union member missing from the tuple above is a type error.
type MissingCode = Exclude<PgBridgeErrorCode, (typeof errorCodes)[number]>;
type MissingWarning = Exclude<BridgeWarningType, (typeof warningTypes)[number]>;
const allCodesListed: [MissingCode] extends [never] ? true : never = true;
const allWarningsListed: [MissingWarning] extends [never] ? true : never = true;

const agentsMd = new URL('../AGENTS.md', import.meta.url);
const text = readFileSync(agentsMd, 'utf8');

describe('AGENTS.md', () => {
  it('names every PgBridgeError code', () => {
    expect(allCodesListed).toBe(true);
    for (const code of errorCodes) expect(text).toContain(`\`${code}\``);
  });

  it('names every bridge warning', () => {
    expect(allWarningsListed).toBe(true);
    for (const type of warningTypes) expect(text).toContain(`\`${type}\``);
  });

  it('stays within the 8 KB ingest budget', () => {
    expect(statSync(agentsMd).size).toBeLessThanOrEqual(8 * 1024);
  });
});
