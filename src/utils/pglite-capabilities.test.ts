import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  computePgliteVersion,
  pgliteNeedsProtocolCleanup,
  pgliteRetainsRawStreamResults,
  resolvePgliteVersion,
} from './pglite-capabilities.ts';

describe('pgliteRetainsRawStreamResults', () => {
  it('returns false for versions that ship electric-sql/pglite#1030 (>= 0.5.3)', () => {
    // major > 0, minor > 5, and minor === 5 with patch >= 3 all clear the gate.
    for (const version of [
      '1.0.0',
      '2.3.4',
      '0.6.0',
      '0.10.0',
      '0.5.3',
      '0.5.4',
      '0.5.10',
      '0.5.3-canary.1',
    ]) {
      expect(pgliteRetainsRawStreamResults(version)).toBe(false);
    }
  });

  it('returns true for versions without #1030 (< 0.5.3)', () => {
    // minor < 5, and minor === 5 with patch < 3, both keep the cleanup on.
    for (const version of ['0.4.0', '0.4.6', '0.5.0', '0.5.1', '0.5.2', '0.5.2-canary.1']) {
      expect(pgliteRetainsRawStreamResults(version)).toBe(true);
    }
  });

  it('returns true (keep cleaning up) when the version is unknown or unparseable', () => {
    for (const version of [undefined, '', 'next', 'x.y.z', '0.5']) {
      expect(pgliteRetainsRawStreamResults(version)).toBe(true);
    }
  });
});

describe('computePgliteVersion', () => {
  const pglitePkg = (version: unknown) => JSON.stringify({ name: '@electric-sql/pglite', version });

  // A readFile fake backed by a path -> contents map that throws (as the real
  // fs does) for any path not present, matching the implementation's "not the
  // package root — keep walking up" catch.
  const fakeReadFile =
    (files: Record<string, string>) =>
    (path: string): string => {
      const contents = files[path];
      if (contents === undefined) {
        throw new Error(`ENOENT: ${path}`);
      }
      return contents;
    };

  const manifestAt = (dir: string) => join(dir, 'package.json');

  it('returns undefined when entry resolution throws', () => {
    const resolveEntry = () => {
      throw new Error('cannot resolve');
    };
    expect(computePgliteVersion(resolveEntry, fakeReadFile({}))).toBeUndefined();
  });

  it('returns the version when the manifest is found in the first directory', () => {
    const dir = '/pkgs/node_modules/@electric-sql/pglite/dist';
    const resolveEntry = () => join(dir, 'index.js');
    const readFile = fakeReadFile({ [manifestAt(dir)]: pglitePkg('0.5.3') });

    expect(computePgliteVersion(resolveEntry, readFile)).toBe('0.5.3');
  });

  it('walks up when readFile throws in the entry directory and succeeds at a parent', () => {
    const entryDir = '/pkgs/node_modules/@electric-sql/pglite/dist';
    const pkgRoot = '/pkgs/node_modules/@electric-sql/pglite';
    const resolveEntry = () => join(entryDir, 'index.js');
    // No package.json in entryDir (readFile throws), one in the parent root.
    const readFile = fakeReadFile({ [manifestAt(pkgRoot)]: pglitePkg('0.5.10') });

    expect(computePgliteVersion(resolveEntry, readFile)).toBe('0.5.10');
  });

  it('skips a non-matching manifest and keeps walking up to a matching one', () => {
    const entryDir = '/pkgs/node_modules/@electric-sql/pglite/dist';
    const pkgRoot = '/pkgs/node_modules/@electric-sql/pglite';
    const resolveEntry = () => join(entryDir, 'index.js');
    const readFile = fakeReadFile({
      // A valid but unrelated manifest in the entry dir.
      [manifestAt(entryDir)]: JSON.stringify({ name: 'some-other-pkg', version: '9.9.9' }),
      [manifestAt(pkgRoot)]: pglitePkg('0.6.0'),
    });

    expect(computePgliteVersion(resolveEntry, readFile)).toBe('0.6.0');
  });

  it('does not match a manifest whose version is not a string', () => {
    const dir = '/pkgs/node_modules/@electric-sql/pglite';
    const resolveEntry = () => join(dir, 'index.js');
    // Matching name but a numeric version — must be rejected, and with no other
    // manifest on the walk-up the result is undefined.
    const readFile = fakeReadFile({ [manifestAt(dir)]: pglitePkg(123) });

    expect(computePgliteVersion(resolveEntry, readFile)).toBeUndefined();
  });

  it('returns undefined when the walk reaches the filesystem root (parent === dir)', () => {
    // Shallow path: dirname('/index.js') === '/', and dirname('/') === '/', so
    // the parent === dir guard breaks the loop before exhausting iterations.
    const resolveEntry = () => '/index.js';
    const readFile = fakeReadFile({});

    expect(computePgliteVersion(resolveEntry, readFile)).toBeUndefined();
  });

  it('returns undefined when the loop exhausts its 5 iterations without a match', () => {
    // A path deep enough that 5 walk-up iterations never reach the root and
    // never find a matching manifest, so the loop falls through to undefined.
    const resolveEntry = () => '/a/b/c/d/e/f/g/index.js';
    const readFile = fakeReadFile({});

    expect(computePgliteVersion(resolveEntry, readFile)).toBeUndefined();
  });
});

describe('resolvePgliteVersion', () => {
  it('reads the installed @electric-sql/pglite version as a semver string', () => {
    const version = resolvePgliteVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the cached value on a second call', () => {
    // The module memoizes after the first (real) resolution above; this call
    // hits the cache branch and must return the identical value.
    const first = resolvePgliteVersion();
    const second = resolvePgliteVersion();
    expect(second).toBe(first);
  });
});

describe('pgliteNeedsProtocolCleanup', () => {
  it('is the composition of pgliteRetainsRawStreamResults and resolvePgliteVersion', () => {
    expect(pgliteNeedsProtocolCleanup()).toBe(
      pgliteRetainsRawStreamResults(resolvePgliteVersion()),
    );
  });
});
