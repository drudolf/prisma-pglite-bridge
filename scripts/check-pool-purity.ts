/**
 * Dist purity gate for the Prisma-free `./pool` entries.
 *
 * Walks the module graph of the built pool entry artifacts —
 * `dist/entry-pool.{mjs,cjs}`, `dist/testing/pool-vitest.{mjs,cjs}`,
 * `dist/testing/pool-jest.{mjs,cjs}` — following every RELATIVE static
 * import, `require()` call, and dynamic `import()` transitively (chunks
 * included), and fails on any reachable `@prisma/*` specifier, subpaths
 * included. Non-relative, non-@prisma specifiers (externals like `pg`,
 * `@electric-sql/pglite`, `vitest`) are ignored and not followed. A
 * relative specifier that does not resolve to an existing file throws:
 * the gate is loud, never silent.
 *
 * Detection is syntactic (regex over the built source) after comments are
 * stripped: tsdown preserves jsdoc in the emitted chunks, and the pool
 * modules legitimately MENTION `@prisma/adapter-pg` in doc examples — a
 * real import can never live inside a comment, so stripping cannot hide a
 * violation. Remaining over-detection (an import-shaped string literal)
 * fails the gate loudly and gets investigated; under-detection is the
 * failure mode the fixture tests guard against. Run via
 * `pnpm check:pool-purity` (CI runs it on every PR after `pnpm build`).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PurityViolation {
  file: string;
  specifier: string;
}

/** One regex per syntactic import form; capture group 1 is the specifier. */
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g, // import|export … from 'x'
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import('x')
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, // CJS require('x')
  /\bimport\s+["']([^"']+)["']/g, // side-effect import 'x'
];

/** Remove block comments and whole-line `//` comments so doc examples in
 *  emitted jsdoc cannot masquerade as imports. Mid-line `//` is left alone
 *  (it may sit inside a string, e.g. a URL); imports never follow code on
 *  the same line in emitted output, so nothing real is lost. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/**
 * Walk the module graph from `entryFiles` and return every reachable
 * `@prisma/*` specifier occurrence. See the module docs for the contract.
 */
export const findPrismaViolations = (entryFiles: string[]): PurityViolation[] => {
  const violations: PurityViolation[] = [];
  const visited = new Set<string>();
  // for-of over a growing array visits appended chunks (index iteration).
  const files: string[] = entryFiles.map((file) => path.resolve(file));

  for (const file of files) {
    if (visited.has(file)) continue;
    visited.add(file);
    const source = stripComments(readFileSync(file, 'utf8'));

    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        // Every pattern has exactly one capture group; String() keeps the
        // read branch-free under noUncheckedIndexedAccess.
        const specifier = String(match[1]);
        if (specifier.startsWith('@prisma/')) {
          violations.push({ file, specifier });
        } else if (specifier.charAt(0) === '.') {
          files.push(path.resolve(path.dirname(file), specifier));
        }
      }
    }
  }

  return violations;
};

/** The shipped artifact set the gate guards — both module formats. */
const POOL_DIST_ENTRIES: readonly string[] = [
  'dist/entry-pool.mjs',
  'dist/entry-pool.cjs',
  'dist/testing/pool-vitest.mjs',
  'dist/testing/pool-vitest.cjs',
  'dist/testing/pool-jest.mjs',
  'dist/testing/pool-jest.cjs',
];

const runCli = (): void => {
  const root = path.resolve(fileURLToPath(import.meta.url), '../..');
  const entries = POOL_DIST_ENTRIES.map((entry) => path.join(root, entry));
  const violations = findPrismaViolations(entries);
  if (violations.length > 0) {
    console.error('check-pool-purity: @prisma/* imports reachable from pool entries:');
    for (const violation of violations) {
      console.error(`  ${violation.file} -> ${violation.specifier}`);
    }
    process.exit(1);
  }
  console.log(`check-pool-purity: OK (${POOL_DIST_ENTRIES.length} entries, 0 violations)`);
};

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runCli();
}
