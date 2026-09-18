/**
 * Anchor guard for the docs pointers: every PgBridgeError code and bridge
 * warning name resolves to a real heading in docs/troubleshooting.md. The
 * pointer anchor is the lowercased code/name (see errorDocsPointer and
 * warningDocsPointer); GitHub slugs a heading whose text is exactly the code
 * (backticks or not) to that same string, which this test verifies with the
 * reference slugger rather than by assumption. The literal lists are checked
 * against the source unions at compile time, so a new code cannot be added
 * without landing here — and, via this test, in the troubleshooting guide.
 */
import { readFileSync } from 'node:fs';
import GithubSlugger from 'github-slugger';
import { describe, expect, it, vi } from 'vitest';
import { errorDocsPointer, type PgBridgeErrorCode } from './errors.ts';
import { type BridgeWarningType, emitBridgeWarning, warningDocsPointer } from './warnings.ts';

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
  'TEMPLATE_LOAD_FAILED',
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

const HEADING = /^#{1,6}\s+(.*)$/;

/** GitHub-style slugs of every heading, in document order. A fresh slugger
 *  per document reproduces GitHub's `-1`, `-2` de-dup suffixes. */
const headingSlugs = (markdown: string): Set<string> => {
  const slugger = new GithubSlugger();
  const slugs = new Set<string>();
  for (const line of markdown.split('\n')) {
    const heading = HEADING.exec(line);
    if (heading) slugs.add(slugger.slug(heading[1] ?? ''));
  }
  return slugs;
};

const troubleshooting = readFileSync(
  new URL('../docs/troubleshooting.md', import.meta.url),
  'utf8',
);
const slugs = headingSlugs(troubleshooting);

/** The anchor half of a docs pointer. */
const anchorOf = (pointer: string): string => pointer.slice(pointer.indexOf('#') + 1);

describe('docs/troubleshooting.md anchors', () => {
  it('slugs a backticked code heading to the lowercased code (GitHub rule)', () => {
    expect(new GithubSlugger().slug('`POOL_NOT_IDLE`')).toBe('pool_not_idle');
    expect(new GithubSlugger().slug('POOL_NOT_IDLE')).toBe('pool_not_idle');
  });

  it('has a heading for every PgBridgeError code', () => {
    expect(allCodesListed).toBe(true);
    const missing = errorCodes.filter((code) => !slugs.has(anchorOf(errorDocsPointer(code))));
    expect(missing).toEqual([]);
  });

  it('has a heading for every bridge warning type', () => {
    expect(allWarningsListed).toBe(true);
    const missing = warningTypes.filter((type) => !slugs.has(anchorOf(warningDocsPointer(type))));
    expect(missing).toEqual([]);
  });

  it('pointer anchors are the lowercased code / type', () => {
    for (const code of errorCodes)
      expect(anchorOf(errorDocsPointer(code))).toBe(code.toLowerCase());
    for (const type of warningTypes) {
      expect(anchorOf(warningDocsPointer(type))).toBe(type.toLowerCase());
    }
  });
});

describe('emitBridgeWarning', () => {
  it('emits the message with the docs tail and the warning type', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    emitBridgeWarning('PGliteBridgeLeakWarning', 'x');
    expect(spy).toHaveBeenCalledTimes(1);
    const [message, options] = spy.mock.calls[0] ?? [];
    expect(message).toBe(
      'x (docs: prisma-pglite-bridge/docs/troubleshooting.md#pglitebridgeleakwarning)',
    );
    expect(options).toEqual({ type: 'PGliteBridgeLeakWarning' });
  });
});
