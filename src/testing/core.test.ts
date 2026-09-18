import { beforeEach, describe, expect, it, vi } from 'vitest';

import { errorDocsPointer, PgBridgeError } from '../errors.ts';
import { createBridgeContext, createBridgeTemplate, loadBridgeTemplate } from './core.ts';

// Drive the guard, rejection and failure/teardown paths in isolation: a fake
// bridge whose close() can reject, a fake PGlite whose static create() can
// reject, with schema apply stubbed so no real WASM instance spins up. The
// success paths run against a real PGlite in ./core.template.test.ts and the
// vitest helper suites; here we pin ordering and error-precedence contracts.
// Both fakes are classes (not vi.fn) so the suite's `restoreMocks` can't wipe
// the constructors between tests; the hoisted spies record what they do.
const { closeSpy, pgliteCloseSpy, pgliteCreateSpy, pgliteCtorSpy, bridgeCtorSpy } = vi.hoisted(
  () => ({
    closeSpy: vi.fn(),
    pgliteCloseSpy: vi.fn(),
    pgliteCreateSpy: vi.fn(),
    pgliteCtorSpy: vi.fn(),
    bridgeCtorSpy: vi.fn(),
  }),
);

// The instances loadBridgeTemplate builds are unreachable when setup fails,
// so close() is asserted through module-level spies instead of real
// prototypes — same isolation style as the bridge mock below.
vi.mock('@electric-sql/pglite', () => ({
  PGlite: class {
    close = pgliteCloseSpy;
    static create = pgliteCreateSpy;
    constructor() {
      pgliteCtorSpy();
    }
  },
}));

vi.mock('../pglite-bridge', () => ({
  PGliteBridge: class {
    pglite = { closed: false };
    adapter = {};
    snapshotDb = () => Promise.resolve();
    close = closeSpy;

    // Mirror the real constructor's synchronous statsLevel guard (see
    // src/pglite-bridge/index.ts) — the remaining synchronous constructor
    // throw now that per-client statement names allow caching at any max.
    constructor(options?: { statsLevel?: string }) {
      bridgeCtorSpy(options);
      const statsLevel = options?.statsLevel ?? 'off';
      if (statsLevel !== 'off' && statsLevel !== 'basic' && statsLevel !== 'full') {
        throw new Error(`statsLevel must be 'off', 'basic', or 'full'; got ${String(statsLevel)}`);
      }
    }
  },
}));
vi.mock('../schema', () => ({ pushSchema: () => Promise.resolve() }));
vi.mock('../schema/migrations.ts', () => ({ pushMigrations: () => Promise.resolve() }));

/** The mocked loader hands out this instance for every successful create(). */
const loadedPglite = { close: pgliteCloseSpy, closed: false };

// The hoisted spies are plain vi.fn()s, which the suite's `restoreMocks` does
// not reset — wipe them here so calls from other tests cannot leak in.
beforeEach(() => {
  closeSpy.mockReset().mockResolvedValue(undefined);
  pgliteCloseSpy.mockReset().mockResolvedValue(undefined);
  pgliteCreateSpy.mockReset().mockResolvedValue(loadedPglite);
  pgliteCtorSpy.mockReset();
  bridgeCtorSpy.mockReset();
});

// The template is never read: the mocked PGlite ignores loadDataDir entirely.
const template = new Blob(['unused-by-the-mocked-pglite']);

const PGLITE_REJECTION = (fn: string, what: string) =>
  `${fn}() does not accept a \`pglite\` option: the ${what} must own its PGlite instance`;

/** Bridge options carrying a caller-supplied instance, as a JS caller (or a
 *  cast) would pass them — the types omit the key, so this bypasses them. */
const withSuppliedPglite = { pglite: { closed: false } } as never;

describe('createBridgeContext schema-source guard', () => {
  it('throws a TypeError naming createBridgeContext when neither migrations nor schema is given', async () => {
    const rejection = createBridgeContext({ client: () => ({}) });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow(
      'createBridgeContext requires exactly one of `migrations` or `schema`',
    );
  });

  it('throws a TypeError naming createBridgeContext when both migrations and schema are given', async () => {
    await expect(
      createBridgeContext({
        client: () => ({}),
        migrations: true,
        schema: { schema: 'model Empty { id Int @id }' },
      }),
    ).rejects.toThrow('createBridgeContext requires exactly one');
  });

  it('runs the guard before any bridge (and thus any PGlite) is constructed', async () => {
    const client = vi.fn(() => ({}));
    await expect(createBridgeContext({ client })).rejects.toThrow(TypeError);
    expect(bridgeCtorSpy).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });
});

describe('createBridgeTemplate schema-source guard', () => {
  it('rejects under its own name when neither source is given', async () => {
    const rejection = createBridgeTemplate({ client: () => ({}) });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow('createBridgeTemplate requires exactly one');
    expect(bridgeCtorSpy).not.toHaveBeenCalled();
  });

  it('rejects under its own name when both sources are given', async () => {
    await expect(
      createBridgeTemplate({
        client: () => ({}),
        migrations: true,
        schema: { schema: 'model Empty { id Int @id }' },
      }),
    ).rejects.toThrow('createBridgeTemplate requires exactly one');
    expect(bridgeCtorSpy).not.toHaveBeenCalled();
  });
});

describe('pglite option rejection', () => {
  it('createBridgeTemplate throws a TypeError and constructs no bridge or PGlite', async () => {
    const client = vi.fn(() => ({}));
    const rejection = createBridgeTemplate({
      client,
      migrations: true,
      bridge: withSuppliedPglite,
    });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow(PGLITE_REJECTION('createBridgeTemplate', 'template'));

    expect(bridgeCtorSpy).not.toHaveBeenCalled();
    expect(pgliteCtorSpy).not.toHaveBeenCalled();
    expect(pgliteCreateSpy).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('loadBridgeTemplate throws a TypeError before PGlite.create is ever called', async () => {
    const client = vi.fn(() => ({}));
    const rejection = loadBridgeTemplate(template, { client, bridge: withSuppliedPglite });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow(
      PGLITE_REJECTION('loadBridgeTemplate', 'loaded context'),
    );

    expect(pgliteCreateSpy).not.toHaveBeenCalled();
    expect(pgliteCtorSpy).not.toHaveBeenCalled();
    expect(bridgeCtorSpy).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
  });

  it('a `pglite: undefined` key is not a supplied instance', async () => {
    const { close } = await loadBridgeTemplate(template, {
      client: () => ({}),
      bridge: { pglite: undefined } as never,
    });
    expect(pgliteCreateSpy).toHaveBeenCalledOnce();
    await close();
  });
});

describe('createBridgeContext close()', () => {
  it('delegates to bridge.close() and never calls prisma.$disconnect()', async () => {
    const $disconnect = vi.fn(async () => {});
    const context = await createBridgeContext({
      client: () => ({ $disconnect }),
      migrations: true,
    });

    await context.close();

    expect(closeSpy).toHaveBeenCalledOnce();
    expect($disconnect).not.toHaveBeenCalled();
  });
});

describe('createBridgeContext failure handling', () => {
  it('closes the bridge and propagates the original setup error even when close() also fails', async () => {
    closeSpy.mockRejectedValueOnce(new Error('close boom'));

    await expect(
      createBridgeContext({
        client: () => ({}),
        migrations: true,
        seed: () => Promise.reject(new Error('seed boom')),
      }),
    ).rejects.toThrow('seed boom');

    // Cleanup still ran; its rejection was swallowed rather than masking the
    // seed error above.
    expect(closeSpy).toHaveBeenCalledOnce();
  });
});

describe('loadBridgeTemplate readiness failure', () => {
  const docsTail = `(docs: ${errorDocsPointer('TEMPLATE_LOAD_FAILED')})`;

  it('wraps a PGlite.create rejection in TEMPLATE_LOAD_FAILED with the cause and docs tail', async () => {
    const boom = new Error('incorrect header check');
    pgliteCreateSpy.mockRejectedValueOnce(boom);
    const client = vi.fn(() => ({}));

    let caught: unknown;
    try {
      await loadBridgeTemplate(template, { client });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PgBridgeError);
    const error = caught as PgBridgeError;
    expect(error.code).toBe('TEMPLATE_LOAD_FAILED');
    expect(error.cause).toBe(boom);
    expect(error.message.endsWith(docsTail)).toBe(true);
    expect(error.message).toContain('not a PGlite data-directory tarball');
    // Nothing downstream of the failed load ran or exists to leak.
    expect(bridgeCtorSpy).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    expect(pgliteCloseSpy).not.toHaveBeenCalled();
  });

  it('passes the template through as a Blob typed by `compression`', async () => {
    await (await loadBridgeTemplate(template, { client: () => ({}) })).close();
    // The loader checks the gzip magic before typing the Blob, so the gzip
    // case needs a template that starts with it.
    const gzipTemplate = new Blob([new Uint8Array([0x1f, 0x8b, 0x08, 0x00])]);
    await (
      await loadBridgeTemplate(gzipTemplate, { client: () => ({}), compression: 'gzip' })
    ).close();

    const typed = pgliteCreateSpy.mock.calls.map(
      (call) => (call[0] as { loadDataDir: Blob }).loadDataDir.type,
    );
    expect(typed).toEqual(['application/x-tar', 'application/x-gzip']);
  });
});

describe('loadBridgeTemplate failure handling', () => {
  it('closes the bridge and the loaded PGlite when the client factory throws', async () => {
    await expect(
      loadBridgeTemplate(template, {
        client: () => {
          throw new Error('factory boom');
        },
      }),
    ).rejects.toThrow('factory boom');

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pgliteCloseSpy).toHaveBeenCalledOnce();
  });

  it('closes the loaded PGlite when the bridge constructor throws', async () => {
    await expect(
      loadBridgeTemplate(template, {
        client: () => ({}),
        bridge: { statsLevel: 'invalid' as 'basic' },
      }),
    ).rejects.toThrow(/statsLevel/);

    expect(pgliteCloseSpy).toHaveBeenCalledOnce();
    // No bridge was ever constructed, so there is nothing to close there.
    expect(closeSpy).not.toHaveBeenCalled();
  });

  it('propagates the setup error even when the teardown itself fails', async () => {
    closeSpy.mockRejectedValueOnce(new Error('bridge teardown boom'));
    pgliteCloseSpy.mockRejectedValueOnce(new Error('pglite teardown boom'));

    await expect(
      loadBridgeTemplate(template, {
        client: () => {
          throw new Error('factory boom');
        },
      }),
    ).rejects.toThrow('factory boom');

    expect(closeSpy).toHaveBeenCalledOnce();
    expect(pgliteCloseSpy).toHaveBeenCalledOnce();
  });
});

describe('loaded context close()', () => {
  it('ends the bridge, then closes the PGlite it loaded, and never calls $disconnect', async () => {
    const order: string[] = [];
    closeSpy.mockImplementation(async () => {
      order.push('bridge');
    });
    pgliteCloseSpy.mockImplementation(async () => {
      order.push('pglite');
    });
    const $disconnect = vi.fn(async () => {});

    const context = await loadBridgeTemplate(template, { client: () => ({ $disconnect }) });
    await context.close();

    expect(order).toEqual(['bridge', 'pglite']);
    expect($disconnect).not.toHaveBeenCalled();
  });

  it('still closes the loaded PGlite when bridge.close() rejects, and rethrows', async () => {
    closeSpy.mockRejectedValueOnce(new Error('bridge close boom'));

    const context = await loadBridgeTemplate(template, { client: () => ({}) });
    await expect(context.close()).rejects.toThrow('bridge close boom');

    expect(pgliteCloseSpy).toHaveBeenCalledOnce();
  });
});
