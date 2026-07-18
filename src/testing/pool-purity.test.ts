/**
 * Unit tests for scripts/check-pool-purity.ts — the dist purity build gate.
 *
 * These tests are RED until scripts/check-pool-purity.ts is created. The gate
 * walks BUILT dist artifacts from a set of entry files and reports every
 * reachable '@prisma/…' import specifier (static imports, require() calls,
 * and dynamic import(), including subpaths). Relative specifiers are followed
 * transitively; non-relative non-@prisma specifiers are ignored and not
 * followed. A relative specifier that does not resolve to an existing file
 * throws — the gate is loud, never silent.
 *
 * Fixtures are tiny synthetic .mjs/.cjs trees in an OS temp directory: the
 * checker reads source text, it never executes the modules.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// This import fails (module missing) until the checker is created — expected.
import { findPrismaViolations, type PurityViolation } from '../../scripts/check-pool-purity.ts';

const tempDirs: string[] = [];

/** Fresh fixture root, registered for afterEach cleanup. */
const makeFixtureDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'purity-'));
  tempDirs.push(dir);
  return dir;
};

/** Writes one fixture module and returns its absolute path. */
const writeModule = (dir: string, name: string, source: string): string => {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, source);
  return filePath;
};

/** Stable order for multi-violation assertions. */
const bySpecifier = (violations: PurityViolation[]): PurityViolation[] =>
  [...violations].sort((a, b) => a.specifier.localeCompare(b.specifier));

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('findPrismaViolations', () => {
  it('returns zero violations for a clean ESM graph whose chunks import only non-prisma externals', () => {
    const dir = makeFixtureDir();
    writeModule(
      dir,
      'chunk-a.mjs',
      `import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
export const x = { pg, PGlite };
`,
    );
    const entry = writeModule(
      dir,
      'entry.mjs',
      `import { x } from './chunk-a.mjs';
export { x };
`,
    );

    expect(findPrismaViolations([entry])).toEqual([]);
  });

  it('reports a direct @prisma import in an entry file with its exact specifier', () => {
    const dir = makeFixtureDir();
    const entry = writeModule(
      dir,
      'entry.mjs',
      `import { PrismaPg } from "@prisma/adapter-pg";
export { PrismaPg };
`,
    );

    expect(findPrismaViolations([entry])).toEqual([
      { file: expect.stringContaining('entry.mjs'), specifier: '@prisma/adapter-pg' },
    ]);
  });

  it('follows re-export-only chunks and reports a transitive @prisma re-export', () => {
    const dir = makeFixtureDir();
    writeModule(
      dir,
      'chunk-b.mjs',
      `export { y } from '@prisma/driver-adapter-utils';
`,
    );
    const entry = writeModule(
      dir,
      'entry.mjs',
      `export * from './chunk-b.mjs';
`,
    );

    expect(findPrismaViolations([entry])).toEqual([
      {
        file: expect.stringContaining('chunk-b.mjs'),
        specifier: '@prisma/driver-adapter-utils',
      },
    ]);
  });

  it('detects a dynamic import() of an @prisma package inside a followed chunk', () => {
    const dir = makeFixtureDir();
    writeModule(
      dir,
      'chunk-d.mjs',
      `export const load = async () => {
  const m = await import("@prisma/adapter-pg");
  return m;
};
`,
    );
    const entry = writeModule(
      dir,
      'entry.mjs',
      `export { load } from './chunk-d.mjs';
`,
    );

    expect(findPrismaViolations([entry])).toEqual([
      { file: expect.stringContaining('chunk-d.mjs'), specifier: '@prisma/adapter-pg' },
    ]);
  });

  it('detects require() of @prisma packages and follows relative requires transitively', () => {
    const dir = makeFixtureDir();
    writeModule(
      dir,
      'chunk-c.cjs',
      `'use strict';
const utils = require('@prisma/driver-adapter-utils');
module.exports = { utils };
`,
    );
    const entry = writeModule(
      dir,
      'entry.cjs',
      `'use strict';
const { PrismaPg } = require("@prisma/adapter-pg");
const chunk = require('./chunk-c.cjs');
module.exports = { PrismaPg, chunk };
`,
    );

    // The second violation lives inside chunk-c.cjs — reaching it proves the
    // clean relative require was followed, not just scanned past.
    expect(bySpecifier(findPrismaViolations([entry]))).toEqual([
      { file: expect.stringContaining('entry.cjs'), specifier: '@prisma/adapter-pg' },
      {
        file: expect.stringContaining('chunk-c.cjs'),
        specifier: '@prisma/driver-adapter-utils',
      },
    ]);
  });

  it('reports @prisma subpath specifiers, not just bare package names', () => {
    const dir = makeFixtureDir();
    const entry = writeModule(
      dir,
      'entry.mjs',
      `import "@prisma/adapter-pg/dist/internal.js";
`,
    );

    expect(findPrismaViolations([entry])).toEqual([
      {
        file: expect.stringContaining('entry.mjs'),
        specifier: '@prisma/adapter-pg/dist/internal.js',
      },
    ]);
  });

  it('ignores lookalike scopes that do not start with @prisma/', () => {
    const dir = makeFixtureDir();
    const entry = writeModule(
      dir,
      'entry.mjs',
      `import { z } from '@prismafake/pkg';
export { z };
`,
    );

    expect(findPrismaViolations([entry])).toEqual([]);
  });

  it('ignores import-shaped text inside comments — tsdown emits jsdoc examples', () => {
    const dir = makeFixtureDir();
    const entry = writeModule(
      dir,
      'entry.mjs',
      `/**
* @example
* import { PrismaPg } from '@prisma/adapter-pg';
* import { PrismaClient } from '@prisma/client';
*/
// import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
export { pg };
`,
    );

    expect(findPrismaViolations([entry])).toEqual([]);
  });

  it('throws when a relative import cannot be resolved to an existing file', () => {
    const dir = makeFixtureDir();
    const entry = writeModule(
      dir,
      'entry.mjs',
      `import './missing-chunk.mjs';
`,
    );

    expect(() => findPrismaViolations([entry])).toThrow(/missing-chunk/);
  });

  it('aggregates violations across multiple entry files', () => {
    const dir = makeFixtureDir();
    const entryOne = writeModule(
      dir,
      'entry-one.mjs',
      `import "@prisma/adapter-pg";
`,
    );
    const entryTwo = writeModule(
      dir,
      'entry-two.mjs',
      `import "@prisma/client";
`,
    );

    expect(bySpecifier(findPrismaViolations([entryOne, entryTwo]))).toEqual([
      { file: expect.stringContaining('entry-one.mjs'), specifier: '@prisma/adapter-pg' },
      { file: expect.stringContaining('entry-two.mjs'), specifier: '@prisma/client' },
    ]);
  });
});
