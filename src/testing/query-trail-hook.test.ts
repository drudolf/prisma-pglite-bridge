/**
 * Unit spec for {@link resolveHelperTrail} — the helper's `queryTrail`
 * precedence resolver (design: .claude/plans/query-trail-design.md §4
 * "Option precedence"). This is the pure decision the CWE-665 review pinned:
 * the helper default must NOT clobber a user's object-form pool/bridge option.
 *
 * Precedence (highest wins): `PGLITE_BRIDGE_QUERY_TRAIL=0` env kill switch →
 * explicit helper option → pool/bridge option → helper default ON. Driven here
 * directly (no PGlite) so every branch is cheap and deterministic; the
 * fixture-path integration tests in `query-trail.*-vitest.test.ts` assert the
 * end-to-end effect (redaction actually taking hold).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveHelperTrail } from './query-trail-hook.ts';

describe('resolveHelperTrail — option precedence', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('env kill switch (highest precedence)', () => {
    it('PGLITE_BRIDGE_QUERY_TRAIL=0 forces off regardless of helper/pool options', () => {
      vi.stubEnv('PGLITE_BRIDGE_QUERY_TRAIL', '0');
      // Even helper true + a pool object cannot override the kill switch.
      expect(resolveHelperTrail(true, { redactParams: true })).toEqual({
        effective: false,
        on: false,
      });
      expect(resolveHelperTrail(undefined, undefined)).toEqual({ effective: false, on: false });
    });

    it('only the exact value "0" disables — any other value is ignored', () => {
      vi.stubEnv('PGLITE_BRIDGE_QUERY_TRAIL', 'false');
      // Not the kill switch: nothing set anywhere else → helper default ON.
      expect(resolveHelperTrail(undefined, undefined)).toEqual({ effective: true, on: true });
    });
  });

  describe('explicit helper option', () => {
    it('helper false forces off, even over a pool object', () => {
      expect(resolveHelperTrail(false, { redactParams: true })).toEqual({
        effective: false,
        on: false,
      });
    });

    it('helper true preserves a pool OBJECT’s settings (not collapsed to a bare true)', () => {
      const object = { redactParams: true, maxEntries: 10 };
      expect(resolveHelperTrail(true, object)).toEqual({ effective: object, on: true });
    });

    it('helper true over a non-object pool value collapses to a plain true', () => {
      // Pool false: helper-on wins → plain true (line 65 `: true` arm).
      expect(resolveHelperTrail(true, false)).toEqual({ effective: true, on: true });
      // Pool true: still a plain true.
      expect(resolveHelperTrail(true, true)).toEqual({ effective: true, on: true });
      // Pool unset: plain true.
      expect(resolveHelperTrail(true, undefined)).toEqual({ effective: true, on: true });
    });
  });

  describe('helper option unset — pool/bridge option governs', () => {
    it('passes a pool object through unchanged (capture on)', () => {
      const object = { maxParamChars: 50 };
      expect(resolveHelperTrail(undefined, object)).toEqual({ effective: object, on: true });
    });

    it('honours a pool true / pool false', () => {
      expect(resolveHelperTrail(undefined, true)).toEqual({ effective: true, on: true });
      expect(resolveHelperTrail(undefined, false)).toEqual({ effective: false, on: false });
    });
  });

  describe('nothing set anywhere', () => {
    it('defaults ON in the helper (plain true)', () => {
      expect(resolveHelperTrail(undefined, undefined)).toEqual({ effective: true, on: true });
    });
  });
});
