/**
 * Surface pin for `./pool-testing.ts` — the `prisma-pglite-bridge/pool/testing`
 * entry. The round-4 condition on design item D enumerates this surface
 * exactly: three runtime builders plus a fixed set of type-only exports, and
 * nothing else. Any extra runtime key is a surface leak; the Prisma-type
 * absence is enforced separately by the dist purity gate.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import * as core from './pool-core.ts';
import type {
  LoadPoolTemplateOptions,
  PGlitePoolTestContext,
  PoolContextOptions,
  PoolTemplate,
  PoolTemplateOptions,
  TemplateCompression,
} from './pool-testing.ts';
import * as entry from './pool-testing.ts';

/** The complete runtime surface, pre-sorted in default string order. */
const expectedValueExports = [
  'createPoolContext',
  'createPoolTemplate',
  'loadPoolTemplate',
] as const;

describe('pool/testing runtime export surface', () => {
  it('exports exactly the three builders and nothing else', () => {
    expect(Object.keys(entry).sort()).toEqual([...expectedValueExports]);
  });

  it('re-exports every builder by identity from the pool core', () => {
    const entryExports: Record<string, unknown> = { ...entry };
    const coreExports: Record<string, unknown> = { ...core };
    for (const name of expectedValueExports) {
      expect(entryExports[name]).toBeTypeOf('function');
      expect(entryExports[name]).toBe(coreExports[name]);
    }
  });

  it('pins the runtime key list at the type level', () => {
    expectTypeOf<keyof typeof import('./pool-testing.ts')>().toEqualTypeOf<
      'createPoolContext' | 'createPoolTemplate' | 'loadPoolTemplate'
    >();
  });
});

describe('pool/testing type-only export surface', () => {
  it('exposes the enumerated types (compile-time pin, no runtime keys)', () => {
    // Referencing each type in a tuple pins its existence at compile time;
    // the tuple's literal length is the only runtime residue.
    type TypeOnlyExports = [
      PoolTemplate,
      PoolContextOptions<unknown>,
      PoolTemplateOptions<unknown>,
      LoadPoolTemplateOptions<unknown>,
      PGlitePoolTestContext<unknown>,
      TemplateCompression,
    ];
    const typeOnlyExportCount: TypeOnlyExports['length'] = 6;
    expect(typeOnlyExportCount).toBe(6);

    expectTypeOf<TemplateCompression>().toEqualTypeOf<'none' | 'gzip'>();
    expectTypeOf<Blob>().toExtend<PoolTemplate>();
    // The template options carry no `pglite` and no `snapshot`; the loader
    // options carry no `setup`/`seed`. Both accept `compression`.
    expectTypeOf<PoolTemplateOptions<unknown>>().not.toHaveProperty('snapshot');
    expectTypeOf<NonNullable<PoolTemplateOptions<unknown>['pool']>>().not.toHaveProperty('pglite');
    expectTypeOf<NonNullable<LoadPoolTemplateOptions<unknown>['pool']>>().not.toHaveProperty(
      'pglite',
    );
    expectTypeOf<PoolTemplateOptions<unknown>['compression']>().toEqualTypeOf<
      TemplateCompression | undefined
    >();
    expectTypeOf<LoadPoolTemplateOptions<unknown>['compression']>().toEqualTypeOf<
      TemplateCompression | undefined
    >();
    expectTypeOf<LoadPoolTemplateOptions<unknown>>().not.toHaveProperty('setup');
  });
});
