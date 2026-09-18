/**
 * Contract tests for `./pool-core.ts` — the Prisma-free, runner-agnostic
 * pool counterpart to `./core.ts`. Most contexts run on one shared PGlite
 * (caller-supplied via `pool.pglite`) to keep WASM cold starts modest; the
 * ownership and dispose-failure tests let the core create its own instance
 * because the owned lifecycle is exactly what they pin, and the template
 * builder/loader always own theirs — a `pglite` option is rejected there.
 */

import { openAsBlob } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { errorDocsPointer, PgBridgeError } from '../errors.ts';
import { PgBridgePool } from '../pool/index.ts';
import { livePoolCounts } from '../pool/session-registry.ts';
import {
  createPoolContext,
  createPoolTemplate,
  loadPoolTemplate,
  type PGlitePoolTestContext,
  type PoolTemplate,
} from './pool-core.ts';
import type { TemplateCompression } from './template.ts';

const pglite = await setupPGlite({ reset: false });

/** Read a table's `label` column in id order — the assertion currency below. */
const labels = async (pool: PgBridgePool, table: string): Promise<string[]> => {
  const { rows } = await pool.query<{ label: string }>(`SELECT label FROM ${table} ORDER BY id`);
  return rows.map((row) => row.label);
};

/** The idle-gate message body shared by resetDb()/snapshotDb() — each method
 *  prefixes its own name; PgBridgeError appends the docs pointer after it.
 *  Pinned verbatim as the message head: the wording is public contract. */
const IDLE_GATE_TAIL =
  'requires no in-flight or waiting pool checkouts; got 1. ' +
  'Await all pending queries (or release checked-out clients) before calling.';

describe('createPoolContext — lifecycle order and snapshot reset', () => {
  const calls: string[] = [];
  let setupContext: { pool: PgBridgePool; pglite: unknown };
  let ctx: PGlitePoolTestContext<{ pool: PgBridgePool }>;

  beforeAll(async () => {
    ctx = await createPoolContext({
      pool: { pglite },
      setup: async (target) => {
        calls.push('setup');
        setupContext = target;
        await target.pool.query(
          'CREATE TABLE core_users (id serial PRIMARY KEY, label text NOT NULL)',
        );
      },
      client: (clientPool) => {
        calls.push('client');
        return { pool: clientPool };
      },
      seed: async (client) => {
        calls.push('seed');
        await client.pool.query("INSERT INTO core_users (label) VALUES ('Ada'), ('Grace')");
      },
    });
  });

  afterAll(async () => {
    await ctx.close();
    await pglite.exec('DROP TABLE IF EXISTS core_users');
    await pglite.exec('DROP SCHEMA IF EXISTS _pglite_snapshot CASCADE');
  });

  it('runs setup, then the client factory, then seed, in that order', () => {
    expect(calls).toEqual(['setup', 'client', 'seed']);
  });

  it('hands setup the pool and pglite, and the client factory the same pool', () => {
    expect(setupContext.pool).toBe(ctx.pool);
    expect(setupContext.pglite).toBe(pglite);
    expect(ctx.pool).toBeInstanceOf(PgBridgePool);
    expect(ctx.pglite).toBe(pglite);
    expect(ctx.client.pool).toBe(ctx.pool);
  });

  it('resetDb restores the seeded snapshot after mutation and deletion', async () => {
    await ctx.pool.query("DELETE FROM core_users WHERE label = 'Ada'");
    await ctx.pool.query("INSERT INTO core_users (label) VALUES ('Mallory')");

    await ctx.resetDb();

    expect(await labels(ctx.pool, 'core_users')).toEqual(['Ada', 'Grace']);
  });

  it('rejects resetDb with POOL_NOT_IDLE while a pool client is checked out', async () => {
    const client = await ctx.pool.connect();
    let caught: unknown;
    try {
      await ctx.resetDb();
    } catch (err) {
      caught = err;
    } finally {
      client.release();
    }

    expect(caught).toBeInstanceOf(PgBridgeError);
    expect((caught as PgBridgeError).code).toBe('POOL_NOT_IDLE');
    expect((caught as PgBridgeError).message.startsWith(`resetDb() ${IDLE_GATE_TAIL}`)).toBe(true);

    // Released — the gate reopens and the reset succeeds again.
    await ctx.resetDb();
  });

  it('rejects snapshotDb with POOL_NOT_IDLE while a pool client is checked out', async () => {
    const client = await ctx.pool.connect();
    let caught: unknown;
    try {
      await ctx.snapshotDb();
    } catch (err) {
      caught = err;
    } finally {
      client.release();
    }

    expect(caught).toBeInstanceOf(PgBridgeError);
    expect((caught as PgBridgeError).code).toBe('POOL_NOT_IDLE');
    expect((caught as PgBridgeError).message.startsWith(`snapshotDb() ${IDLE_GATE_TAIL}`)).toBe(
      true,
    );
  });

  it('snapshotDb re-captures the current state as the new reset baseline', async () => {
    await ctx.pool.query("INSERT INTO core_users (label) VALUES ('Hopper')");
    await ctx.snapshotDb();
    await ctx.pool.query('DELETE FROM core_users');

    await ctx.resetDb();

    expect(await labels(ctx.pool, 'core_users')).toEqual(['Ada', 'Grace', 'Hopper']);
  });
});

describe('createPoolContext — snapshot: false', () => {
  it('resetDb truncates user tables to empty while the schema survives', async () => {
    const ctx = await createPoolContext({
      pool: { pglite },
      snapshot: false,
      setup: async ({ pool }) => {
        await pool.query('CREATE TABLE nosnap_items (id serial PRIMARY KEY, label text NOT NULL)');
      },
      client: (pool) => ({ pool }),
      seed: async ({ pool }) => {
        await pool.query("INSERT INTO nosnap_items (label) VALUES ('seeded')");
      },
    });
    try {
      await ctx.resetDb();

      // Rows gone, table still there: the empty read and a fresh insert both work.
      expect(await labels(ctx.pool, 'nosnap_items')).toEqual([]);
      await ctx.pool.query("INSERT INTO nosnap_items (label) VALUES ('after-reset')");
      expect(await labels(ctx.pool, 'nosnap_items')).toEqual(['after-reset']);
    } finally {
      await ctx.close();
      await pglite.exec('DROP TABLE IF EXISTS nosnap_items');
    }
  });
});

describe('createPoolContext — async client factory', () => {
  it('awaits the factory and seeds with the resolved client', async () => {
    let seededWith: unknown;
    const ctx = await createPoolContext({
      pool: { pglite },
      snapshot: false,
      setup: async () => {},
      client: async (pool) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { pool, tag: 'async' as const };
      },
      seed: async (client) => {
        seededWith = client;
      },
    });
    try {
      expect(ctx.client.tag).toBe('async');
      expect(seededWith).toBe(ctx.client);
    } finally {
      await ctx.close();
    }
  });
});

describe('createPoolContext — PGlite ownership', () => {
  it('close() closes the pool and the internally created PGlite when none is supplied', async () => {
    const ctx = await createPoolContext({
      snapshot: false,
      setup: async ({ pool }) => {
        await pool.query('SELECT 1');
      },
      client: (pool) => ({ pool }),
    });
    expect(ctx.pglite).not.toBe(pglite);
    expect(ctx.pglite.closed).toBe(false);

    await ctx.close();

    expect(ctx.pglite.closed).toBe(true);
    await expect(ctx.pool.connect()).rejects.toThrow(/after calling end/);
  });

  it('close() leaves a caller-supplied pglite open', async () => {
    const ctx = await createPoolContext({
      pool: { pglite },
      snapshot: false,
      setup: async () => {},
      client: (pool) => ({ pool }),
    });

    await ctx.close();

    expect(pglite.closed).toBe(false);
    const { rows } = await pglite.query<{ ok: number }>('SELECT 1 AS ok');
    expect(rows[0]?.ok).toBe(1);
  });
});

describe('createPoolContext — dispose', () => {
  it('runs dispose before the pool closes', async () => {
    let disposeSawLivePool = false;
    const ctx = await createPoolContext({
      pool: { pglite },
      snapshot: false,
      setup: async () => {},
      client: (pool) => ({ pool }),
      dispose: async ({ pool }) => {
        const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
        disposeSawLivePool = rows[0]?.ok === 1;
      },
    });

    await ctx.close();

    expect(disposeSawLivePool).toBe(true);
  });

  it('tolerates a dispose that itself ends the pool', async () => {
    const ctx = await createPoolContext({
      pool: { pglite },
      snapshot: false,
      setup: async () => {},
      client: (pool) => ({ pool }),
      dispose: async ({ pool }) => {
        await pool.end();
      },
    });

    await expect(ctx.close()).resolves.toBeUndefined();
  });

  it('propagates a dispose error but still closes the pool and the owned pglite', async () => {
    const ctx = await createPoolContext({
      snapshot: false,
      setup: async ({ pool }) => {
        await pool.query('SELECT 1');
      },
      client: (pool) => ({ pool }),
      dispose: async () => {
        throw new Error('dispose boom');
      },
    });

    await expect(ctx.close()).rejects.toThrow('dispose boom');

    expect(ctx.pglite.closed).toBe(true);
    await expect(ctx.pool.connect()).rejects.toThrow(/after calling end/);
  });
});

describe('createPoolContext — failure containment', () => {
  it('setup error: rejects, closes the pool, never calls client or dispose', async () => {
    const client = vi.fn((pool: PgBridgePool) => ({ pool }));
    const dispose = vi.fn(async () => {});
    const baseline = livePoolCounts.get(pglite) ?? 0;

    await expect(
      createPoolContext({
        pool: { pglite },
        setup: async ({ pool }) => {
          await pool.query('SELECT 1');
          throw new Error('setup boom');
        },
        client,
        dispose,
      }),
    ).rejects.toThrow('setup boom');

    expect(client).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    // Pool closed: its slot in the shared-instance registry is released again
    // by the time the rejection reaches the caller.
    expect(livePoolCounts.get(pglite) ?? 0).toBe(baseline);
  });

  it('seed error: rejects, attempts dispose best-effort, swallows its failure', async () => {
    const disposeCalls: unknown[] = [];
    let builtClient: unknown;
    const baseline = livePoolCounts.get(pglite) ?? 0;

    await expect(
      createPoolContext({
        pool: { pglite },
        setup: async () => {},
        client: (pool) => {
          const built = { pool };
          builtClient = built;
          return built;
        },
        seed: async () => {
          throw new Error('seed boom');
        },
        dispose: async (client) => {
          disposeCalls.push(client);
          throw new Error('dispose boom');
        },
      }),
    ).rejects.toThrow('seed boom');

    expect(disposeCalls).toEqual([builtClient]);
    expect(livePoolCounts.get(pglite) ?? 0).toBe(baseline);
  });

  it('seed error without dispose on an owned instance: rejects and tears down', async () => {
    // Covers the dispose-less failure arm and the owned-PGlite close inside
    // the containment path (the other failure tests use the shared instance).
    await expect(
      createPoolContext({
        setup: async () => {},
        client: (pool) => ({ pool }),
        seed: async () => {
          throw new Error('seed boom');
        },
      }),
    ).rejects.toThrow('seed boom');
  });
});

describe('createPoolTemplate', () => {
  it('returns a dump, skips the snapshot step, and tears its own instance down', async () => {
    let templatePglite: PGlite | undefined;
    let snapshotSchemaMissing: boolean | undefined;

    const template = await createPoolTemplate({
      setup: async ({ pool, pglite: owned }) => {
        templatePglite = owned as PGlite;
        await pool.query('CREATE TABLE tmpl_items (id serial PRIMARY KEY, label text NOT NULL)');
      },
      client: (pool) => ({ pool }),
      seed: async ({ pool }) => {
        await pool.query("INSERT INTO tmpl_items (label) VALUES ('from-template')");
        // The dump IS the template — no `_pglite_snapshot` schema is taken.
        const { rows } = await pool.query<{ missing: boolean }>(
          "SELECT to_regnamespace('_pglite_snapshot') IS NULL AS missing",
        );
        snapshotSchemaMissing = rows[0]?.missing;
      },
    });

    expect(template).toBeInstanceOf(Blob);
    expect(template.type).toBe('application/x-tar');
    expect(snapshotSchemaMissing).toBe(true);
    // The template owned its instance and closed it after the dump.
    expect(templatePglite).not.toBe(pglite);
    expect(templatePglite?.closed).toBe(true);
  });

  it('rejects a supplied pglite with a TypeError before creating anything', async () => {
    const setup = vi.fn(async () => {});
    const client = vi.fn((pool: PgBridgePool) => ({ pool }));
    const baseline = livePoolCounts.get(pglite) ?? 0;

    const rejection = createPoolTemplate({
      pool: { pglite } as never,
      setup,
      client,
    });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow(
      'createPoolTemplate() does not accept a `pglite` option: the template must own its PGlite instance',
    );

    expect(setup).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    // No pool was built over the supplied instance.
    expect(livePoolCounts.get(pglite) ?? 0).toBe(baseline);
  });
});

describe('loadPoolTemplate', () => {
  let template: PoolTemplate;

  beforeAll(async () => {
    template = await createPoolTemplate({
      setup: async ({ pool }) => {
        await pool.query('CREATE TABLE dump_items (id serial PRIMARY KEY, label text NOT NULL)');
      },
      client: (pool) => ({ pool }),
      seed: async ({ pool }) => {
        await pool.query("INSERT INTO dump_items (label) VALUES ('from-template')");
      },
    });
  });

  it('loads a fresh instance at the template state; close() shuts it down', async () => {
    const dispose = vi.fn(async () => {});
    const loaded = await loadPoolTemplate(template, {
      client: (pool) => ({ pool }),
      dispose,
    });

    expect(loaded.pglite).not.toBe(pglite);
    // Seed rows are present without any seed callback having run.
    expect(await labels(loaded.pool, 'dump_items')).toEqual(['from-template']);

    await loaded.close();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledWith(loaded.client);
    expect(loaded.pglite.closed).toBe(true);
    await expect(loaded.pool.connect()).rejects.toThrow(/after calling end/);
  });

  it('close() without dispose never reaches into the client (no $disconnect call)', async () => {
    const $disconnect = vi.fn(async () => {});
    const loaded = await loadPoolTemplate(template, { client: (pool) => ({ pool, $disconnect }) });

    await loaded.close();

    expect($disconnect).not.toHaveBeenCalled();
    expect(loaded.pglite.closed).toBe(true);
  });

  it('a loaded context holds no snapshot: resetDb() truncates to empty', async () => {
    const loaded = await loadPoolTemplate(template, { client: (pool) => ({ pool }) });
    try {
      await loaded.resetDb();

      expect(await labels(loaded.pool, 'dump_items')).toEqual([]);
      // The schema survived the truncate: a fresh insert still works.
      await loaded.pool.query("INSERT INTO dump_items (label) VALUES ('after-reset')");
      expect(await labels(loaded.pool, 'dump_items')).toEqual(['after-reset']);
    } finally {
      await loaded.close();
    }
  });

  it('loads a Blob that carries its own MIME type', async () => {
    const typed = new Blob([template], { type: 'application/x-tar' });
    const loaded = await loadPoolTemplate(typed, { client: (pool) => ({ pool }) });
    try {
      expect(await labels(loaded.pool, 'dump_items')).toEqual(['from-template']);
    } finally {
      await loaded.close();
    }
  });

  it('rejects and tears the loaded instance down when the client factory throws', async () => {
    await expect(
      loadPoolTemplate(template, {
        client: () => {
          throw new Error('factory boom');
        },
      }),
    ).rejects.toThrow('factory boom');
  });

  it('close() tolerates an owned instance the caller already closed via ctx.pglite', async () => {
    const loaded = await loadPoolTemplate(template, { client: (pool) => ({ pool }) });
    await loaded.pool.end();
    await loaded.pglite.close();

    await expect(loaded.close()).resolves.toBeUndefined();
  });

  it('loads independent contexts — mutating one does not affect another', async () => {
    const first = await loadPoolTemplate(template, { client: (pool) => ({ pool }) });
    const second = await loadPoolTemplate(template, { client: (pool) => ({ pool }) });
    try {
      await first.pool.query("INSERT INTO dump_items (label) VALUES ('only-in-first')");

      expect(await labels(first.pool, 'dump_items')).toEqual(['from-template', 'only-in-first']);
      expect(await labels(second.pool, 'dump_items')).toEqual(['from-template']);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it('rejects a supplied pglite with a TypeError before PGlite.create is called', async () => {
    const create = vi.spyOn(PGlite, 'create');
    const client = vi.fn((pool: PgBridgePool) => ({ pool }));
    const baseline = livePoolCounts.get(pglite) ?? 0;

    const rejection = loadPoolTemplate(template, { pool: { pglite } as never, client });
    await expect(rejection).rejects.toBeInstanceOf(TypeError);
    await expect(rejection).rejects.toThrow(
      'loadPoolTemplate() does not accept a `pglite` option: the loaded context must own its PGlite instance',
    );

    expect(create).not.toHaveBeenCalled();
    expect(client).not.toHaveBeenCalled();
    expect(livePoolCounts.get(pglite) ?? 0).toBe(baseline);
  });
});

describe('loadPoolTemplate — compression round trip through a file', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ppb-pool-template-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Build → write → read back untyped via openAsBlob → load. */
  const roundTrip = async (
    compression: TemplateCompression,
  ): Promise<PGlitePoolTestContext<{ pool: PgBridgePool }>> => {
    const built = await createPoolTemplate({
      setup: async ({ pool }) => {
        await pool.query('CREATE TABLE rt_items (id serial PRIMARY KEY, label text NOT NULL)');
      },
      client: (pool) => ({ pool }),
      seed: async ({ pool }) => {
        await pool.query(`INSERT INTO rt_items (label) VALUES ('${compression}')`);
      },
      compression,
    });
    expect(built.type).toBe(compression === 'gzip' ? 'application/x-gzip' : 'application/x-tar');
    const file = join(dir, `template.${compression}`);
    await writeFile(file, new Uint8Array(await built.arrayBuffer()));
    const fromDisk = await openAsBlob(file);
    // A Blob read back from disk carries no MIME type — the loader must
    // reconstruct it from `compression`.
    expect(fromDisk.type).toBe('');
    return loadPoolTemplate(fromDisk, { client: (pool) => ({ pool }), compression });
  };

  it("compression: 'none' survives writeFile → openAsBlob → load", async () => {
    const loaded = await roundTrip('none');
    try {
      expect(await labels(loaded.pool, 'rt_items')).toEqual(['none']);
    } finally {
      await loaded.close();
    }
  });

  it("compression: 'gzip' survives writeFile → openAsBlob → load", async () => {
    const loaded = await roundTrip('gzip');
    try {
      expect(await labels(loaded.pool, 'rt_items')).toEqual(['gzip']);
    } finally {
      await loaded.close();
    }
  });
});

describe('loadPoolTemplate — TEMPLATE_LOAD_FAILED', () => {
  const docsTail = `(docs: ${errorDocsPointer('TEMPLATE_LOAD_FAILED')})`;

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
    const client = vi.fn((pool: PgBridgePool) => ({ pool }));
    let caught: unknown;
    const warnings = await collectWarnings(async () => {
      try {
        await loadPoolTemplate(new Blob(['not a tar']), { client });
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBeInstanceOf(PgBridgeError);
    const error = caught as PgBridgeError;
    expect(error.code).toBe('TEMPLATE_LOAD_FAILED');
    expect(error.docs).toBe(errorDocsPointer('TEMPLATE_LOAD_FAILED'));
    expect(error.cause).toBeDefined();
    expect(error.message.endsWith(docsTail)).toBe(true);
    // No pool was ever built, so the client factory never ran.
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
      const template = await createPoolTemplate({
        setup: async ({ pool }) => {
          await pool.query('CREATE TABLE mm_items (id serial PRIMARY KEY)');
        },
        client: (pool) => ({ pool }),
        compression: dumped,
      });
      // Spy after the build: constructing a PGlite goes through `create` too.
      const create = vi.spyOn(PGlite, 'create').mockClear();
      const client = vi.fn((pool: PgBridgePool) => ({ pool }));

      let caught: unknown;
      try {
        await loadPoolTemplate(template, { client, compression: loadedAs });
      } catch (err) {
        caught = err;
      }

      expect(create).not.toHaveBeenCalled();
      expect(client).not.toHaveBeenCalled();
      expect(caught).toBeInstanceOf(PgBridgeError);
      expect((caught as PgBridgeError).code).toBe('TEMPLATE_LOAD_FAILED');
      expect((caught as PgBridgeError).message).toMatch(message);
      expect((caught as PgBridgeError).cause).toBeUndefined();
    },
  );
});
