import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Whether a given PGlite version still accumulates parsed protocol messages
 * during `execProtocolRawStream` — the behaviour the bridge's periodic
 * protocol-message cleanup compensates for.
 *
 * electric-sql/pglite#1030 (first released in 0.5.3) stops that accumulation,
 * making the cleanup redundant. Returns `false` from 0.5.3 onward, `true`
 * before it, and `true` for an unknown or unparseable version — keep cleaning
 * up rather than risk unbounded growth against an undetected old runtime.
 */
export const pgliteRetainsRawStreamResults = (version: string | undefined): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 0) return false;
  if (minor !== 5) return minor < 5;
  return patch < 3;
};

/**
 * Find the `@electric-sql/pglite` version by walking up from the directory of
 * `resolveEntry()` (the resolved package entry) until a `package.json` with a
 * matching name and string version is found. Returns `undefined` if entry
 * resolution fails or no matching manifest is found within a few levels.
 *
 * IO is injected so the resolution logic is exercised in isolation;
 * {@link resolvePgliteVersion} wires the real `require.resolve`/`readFileSync`.
 */
export const computePgliteVersion = (
  resolveEntry: () => string,
  readFile: (path: string) => string,
): string | undefined => {
  let dir: string;
  try {
    dir = dirname(resolveEntry());
  } catch {
    return undefined;
  }
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFile(join(dir, 'package.json')));
      if (pkg.name === '@electric-sql/pglite' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // Not the package root — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
};

let cachedVersion: string | undefined;
let versionResolved = false;

/**
 * Version of the `@electric-sql/pglite` copy this bridge resolves, read once
 * from its package manifest (the package's exports map blocks importing
 * `package.json` directly). Returns `undefined` if it can't be determined.
 * Node-only — the bridge depends on `pg`, so it never runs in a browser.
 *
 * Note: this is the bridge's resolved copy, not necessarily the version of a
 * caller-supplied PGlite instance (which exposes no runtime version). In the
 * common case the bridge creates the instance from this same copy, so they
 * match; a mismatch only costs a redundant or skipped best-effort cleanup.
 */
export const resolvePgliteVersion = (): string | undefined => {
  if (!versionResolved) {
    versionResolved = true;
    const require = createRequire(import.meta.url);
    cachedVersion = computePgliteVersion(
      () => require.resolve('@electric-sql/pglite'),
      (path) => readFileSync(path, 'utf8'),
    );
  }
  return cachedVersion;
};

/**
 * Whether the bridge should run its PGlite protocol-message cleanup against the
 * resolved PGlite. `false` on PGlite >= 0.5.3 (electric-sql/pglite#1030 removed
 * the accumulation the cleanup compensates for); `true` otherwise, including
 * when the version is undetectable.
 */
export const pgliteNeedsProtocolCleanup = (): boolean =>
  pgliteRetainsRawStreamResults(resolvePgliteVersion());
