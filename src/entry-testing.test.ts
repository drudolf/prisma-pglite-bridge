/**
 * Surface pin for `./entry-testing.ts` — the `prisma-pglite-bridge/testing`
 * entry (design item D): three runtime builders plus a fixed set of
 * type-only exports, and nothing else. Any extra runtime key is a surface
 * leak.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import type {
  BridgeContext,
  BridgeContextOptions,
  BridgeTemplate,
  BridgeTemplateOptions,
  LoadBridgeTemplateOptions,
  TemplateCompression,
} from './entry-testing.ts';
import * as entry from './entry-testing.ts';
import * as core from './testing/core.ts';

/** The complete runtime surface, pre-sorted in default string order. */
const expectedValueExports = [
  'createBridgeContext',
  'createBridgeTemplate',
  'loadBridgeTemplate',
] as const;

describe('testing entry runtime export surface', () => {
  it('exports exactly the three builders and nothing else', () => {
    expect(Object.keys(entry).sort()).toEqual([...expectedValueExports]);
  });

  it('re-exports every builder by identity from the Prisma core', () => {
    const entryExports: Record<string, unknown> = { ...entry };
    const coreExports: Record<string, unknown> = { ...core };
    for (const name of expectedValueExports) {
      expect(entryExports[name]).toBeTypeOf('function');
      expect(entryExports[name]).toBe(coreExports[name]);
    }
  });

  it('pins the runtime key list at the type level', () => {
    expectTypeOf<keyof typeof import('./entry-testing.ts')>().toEqualTypeOf<
      'createBridgeContext' | 'createBridgeTemplate' | 'loadBridgeTemplate'
    >();
  });
});

describe('testing entry type-only export surface', () => {
  it('exposes the enumerated types (compile-time pin, no runtime keys)', () => {
    type TypeOnlyExports = [
      BridgeTemplate,
      BridgeContext<unknown>,
      BridgeContextOptions<unknown>,
      BridgeTemplateOptions<unknown>,
      LoadBridgeTemplateOptions<unknown>,
      TemplateCompression,
    ];
    const typeOnlyExportCount: TypeOnlyExports['length'] = 6;
    expect(typeOnlyExportCount).toBe(6);

    expectTypeOf<TemplateCompression>().toEqualTypeOf<'none' | 'gzip'>();
    expectTypeOf<Blob>().toExtend<BridgeTemplate>();
    // The context has close(); the builder options carry no `registerHooks`
    // (that lives on the runner entries); the template options carry no
    // `snapshot` and no `bridge.pglite`; both template and loader options
    // accept `compression`.
    expectTypeOf<keyof BridgeContext<unknown>>().toEqualTypeOf<'prisma' | 'bridge' | 'close'>();
    expectTypeOf<BridgeContextOptions<unknown>>().not.toHaveProperty('registerHooks');
    expectTypeOf<BridgeTemplateOptions<unknown>>().not.toHaveProperty('snapshot');
    expectTypeOf<NonNullable<BridgeTemplateOptions<unknown>['bridge']>>().not.toHaveProperty(
      'pglite',
    );
    expectTypeOf<NonNullable<LoadBridgeTemplateOptions<unknown>['bridge']>>().not.toHaveProperty(
      'pglite',
    );
    expectTypeOf<BridgeTemplateOptions<unknown>['compression']>().toEqualTypeOf<
      TemplateCompression | undefined
    >();
    expectTypeOf<LoadBridgeTemplateOptions<unknown>['compression']>().toEqualTypeOf<
      TemplateCompression | undefined
    >();
  });
});
