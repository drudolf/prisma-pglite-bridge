/**
 * Real-PGlite contract tests for the Prisma core's template builders and
 * `close()` ownership (`./core.ts`): the runtime behavior the mocked
 * `./core.test.ts` cannot observe. The client factory returns the driver
 * adapter's connection rather than a generated `@prisma/client` (which the
 * bridge deliberately cannot import), so seeded rows are read back through
 * `queryRaw` — the same path a real client takes.
 */

import { openAsBlob } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { errorDocsPointer, PgBridgeError } from '../errors.ts';
import {
  type BridgeContext,
  type BridgeTemplate,
  createBridgeContext,
  createBridgeTemplate,
  loadBridgeTemplate,
} from './core.ts';
import type { TemplateCompression } from './template.ts';

/** Inline single-model schema — a few hundred ms per WASM schema push, so
 *  the suites below build one template each and reuse it. */
const WIDGET_SCHEMA = 'model Widget {\n  id Int @id @default(autoincrement())\n  label String\n}';

interface RawClient {
  conn: ReturnType<PrismaPg['connect']>;
  $disconnect: () => Promise<void>;
}

/** The "client": the adapter's connection plus a `$disconnect` spy that
 *  `close()` must never touch. */
const rawClient = (adapter: PrismaPg): RawClient => ({
  conn: adapter.connect(),
  $disconnect: vi.fn(async () => {}),
});

/** Read every Widget label in id order — the assertion currency below. */
const labels = async (client: RawClient): Promise<string[]> => {
  const conn = await client.conn;
  const { rows } = await conn.queryRaw({
    sql: 'SELECT label FROM "Widget" ORDER BY id',
    args: [],
    argTypes: [],
  });
  return rows.map((row) => String(row[0]));
};

const seedAda = async (client: RawClient): Promise<void> => {
  const conn = await client.conn;
  await conn.executeRaw({
    sql: 'INSERT INTO "Widget" (label) VALUES ($1)',
    args: ['Ada'],
    argTypes: [{ scalarType: 'string', arity: 'scalar' }],
  });
};

const DOCS_TAIL = `(docs: ${errorDocsPointer('TEMPLATE_LOAD_FAILED')})`;

describe('createBridgeContext close() ownership', () => {
  it('closes the PGlite it created itself, and never calls $disconnect', async () => {
    const context = await createBridgeContext({
      client: rawClient,
      schema: { schema: WIDGET_SCHEMA },
      snapshot: false,
    });
    expect(context.bridge.pglite.closed).toBe(false);

    await context.close();

    expect(context.bridge.pglite.closed).toBe(true);
    expect(context.prisma.$disconnect).not.toHaveBeenCalled();
  });

  it('leaves a caller-supplied pglite open', async () => {
    const pglite = await PGlite.create();
    try {
      const context = await createBridgeContext({
        client: rawClient,
        schema: { schema: WIDGET_SCHEMA },
        snapshot: false,
        bridge: { pglite },
      });
      expect(context.bridge.pglite).toBe(pglite);

      await context.close();

      expect(pglite.closed).toBe(false);
      const { rows } = await pglite.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
      expect(context.prisma.$disconnect).not.toHaveBeenCalled();
    } finally {
      await pglite.close();
    }
  });
});

describe('createBridgeTemplate + loadBridgeTemplate', () => {
  let template: BridgeTemplate;

  beforeAll(async () => {
    template = await createBridgeTemplate({
      client: rawClient,
      schema: { schema: WIDGET_SCHEMA },
      seed: seedAda,
    });
  });

  it('dumps a Blob typed as a plain tar by default', () => {
    expect(template).toBeInstanceOf(Blob);
    expect(template.type).toBe('application/x-tar');
    expect(template.size).toBeGreaterThan(0);
  });

  it('loads a fresh instance carrying the seeded rows; close() shuts it down without $disconnect', async () => {
    const loaded = await loadBridgeTemplate(template, { client: rawClient });

    expect(await labels(loaded.prisma)).toEqual(['Ada']);
    expect(loaded.bridge.pglite.closed).toBe(false);

    await loaded.close();

    expect(loaded.bridge.pglite.closed).toBe(true);
    expect(loaded.prisma.$disconnect).not.toHaveBeenCalled();
  });

  it('loads independent contexts — mutating one does not affect another', async () => {
    const first = await loadBridgeTemplate(template, { client: rawClient });
    const second = await loadBridgeTemplate(template, { client: rawClient });
    try {
      await seedAda(first.prisma);

      expect(await labels(first.prisma)).toEqual(['Ada', 'Ada']);
      expect(await labels(second.prisma)).toEqual(['Ada']);
      expect(first.bridge.pglite).not.toBe(second.bridge.pglite);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('a loaded context holds no snapshot: resetDb() truncates to empty', async () => {
    const loaded = await loadBridgeTemplate(template, { client: rawClient });
    try {
      await loaded.bridge.resetDb();

      expect(await labels(loaded.prisma)).toEqual([]);
      // The schema survived the truncate: a fresh insert still works.
      await seedAda(loaded.prisma);
      expect(await labels(loaded.prisma)).toEqual(['Ada']);
    } finally {
      await loaded.close();
    }
  });

  it('loads a Blob that carries its own MIME type', async () => {
    const typed = new Blob([template], { type: 'application/x-tar' });
    const loaded = await loadBridgeTemplate(typed, { client: rawClient });
    try {
      expect(await labels(loaded.prisma)).toEqual(['Ada']);
    } finally {
      await loaded.close();
    }
  });
});

describe('compression round trip through a file', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppb-bridge-template-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Build → write → read back untyped via openAsBlob → load. */
  const roundTrip = async (compression: TemplateCompression): Promise<BridgeContext<RawClient>> => {
    const built = await createBridgeTemplate({
      client: rawClient,
      schema: { schema: WIDGET_SCHEMA },
      seed: seedAda,
      compression,
    });
    const file = join(dir, `template.${compression}`);
    await writeFile(file, new Uint8Array(await built.arrayBuffer()));
    const fromDisk = await openAsBlob(file);
    // A Blob read back from disk carries no MIME type — the loader must
    // reconstruct it from `compression`.
    expect(fromDisk.type).toBe('');
    return loadBridgeTemplate(fromDisk, { client: rawClient, compression });
  };

  it("compression: 'none' survives writeFile → openAsBlob → load", async () => {
    const loaded = await roundTrip('none');
    try {
      expect(await labels(loaded.prisma)).toEqual(['Ada']);
    } finally {
      await loaded.close();
    }
  });

  it("compression: 'gzip' survives writeFile → openAsBlob → load, and is smaller", async () => {
    const gzipped = await createBridgeTemplate({
      client: rawClient,
      schema: { schema: WIDGET_SCHEMA },
      compression: 'gzip',
    });
    const plain = await createBridgeTemplate({
      client: rawClient,
      schema: { schema: WIDGET_SCHEMA },
    });
    expect(gzipped.type).toBe('application/x-gzip');
    expect(gzipped.size).toBeLessThan(plain.size);

    const loaded = await roundTrip('gzip');
    try {
      expect(await labels(loaded.prisma)).toEqual(['Ada']);
    } finally {
      await loaded.close();
    }
  });
});

describe('TEMPLATE_LOAD_FAILED', () => {
  /** Collect bridge warnings emitted while `run` executes (warnings are
   *  emitted on a later tick, so drain the loop before reading). */
  const collectWarnings = async (run: () => Promise<void>): Promise<string[]> => {
    const names: string[] = [];
    const onWarning = (warning: Error): void => {
      if (warning.name.startsWith('PGliteBridge')) names.push(warning.name);
    };
    process.on('warning', onWarning);
    try {
      await run();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.removeListener('warning', onWarning);
    }
    return names;
  };

  it('a garbage Blob rejects with a typed, caused, docs-pointed error and nothing leaks', async () => {
    const client = vi.fn(rawClient);
    let caught: unknown;
    const warnings = await collectWarnings(async () => {
      try {
        await loadBridgeTemplate(new Blob(['not a tar']), { client });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(PgBridgeError);
    const error = caught as PgBridgeError;
    expect(error.code).toBe('TEMPLATE_LOAD_FAILED');
    expect(error.docs).toBe(errorDocsPointer('TEMPLATE_LOAD_FAILED'));
    expect(error.cause).toBeDefined();
    expect(error.message.endsWith(DOCS_TAIL)).toBe(true);
    expect(client).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
  });

  it.each([
    ['gzip', 'none', /gzip-compressed but `compression` is 'none'/],
    ['none', 'gzip', /`compression` is 'gzip' but the template is not gzip-compressed/],
  ] as const)(
    "a %s template loaded with compression: '%s' fails before PGlite sees it",
    async (dumped, loadedAs, message) => {
      // The loader checks the gzip magic itself: PGlite's gunzip helper leaks
      // unhandled rejections on a failed inflate (which would fail this run),
      // and it sniffs the magic on its own, which would let the gzip-as-none
      // direction pass silently against the documented contract.
      const template = await createBridgeTemplate({
        client: rawClient,
        schema: { schema: WIDGET_SCHEMA },
        compression: dumped,
      });
      // Spy after the build: constructing a PGlite goes through `create` too.
      const create = vi.spyOn(PGlite, 'create').mockClear();
      const clientFactory = vi.fn(rawClient);

      let caught: unknown;
      try {
        await loadBridgeTemplate(template, { client: clientFactory, compression: loadedAs });
      } catch (err) {
        caught = err;
      }

      expect(create).not.toHaveBeenCalled();
      expect(clientFactory).not.toHaveBeenCalled();
      expect(caught).toBeInstanceOf(PgBridgeError);
      expect((caught as PgBridgeError).code).toBe('TEMPLATE_LOAD_FAILED');
      expect((caught as PgBridgeError).message).toMatch(message);
      expect((caught as PgBridgeError).cause).toBeUndefined();
    },
  );
});

// Kept last: setupPGlite registers a file-level afterAll that closes its
// instance — the shared-instance suite only needs it for one assertion.
describe('createBridgeContext with a shared instance (regression)', () => {
  const sharedPromise = setupPGlite({ reset: false });

  it('two sequential contexts on one supplied pglite both close without touching it', async () => {
    const shared = await sharedPromise;
    for (let i = 0; i < 2; i += 1) {
      const context = await createBridgeContext({
        client: rawClient,
        schema: { schema: WIDGET_SCHEMA },
        snapshot: false,
        bridge: { pglite: shared },
      });
      await context.close();
    }
    expect(shared.closed).toBe(false);
  });
});
