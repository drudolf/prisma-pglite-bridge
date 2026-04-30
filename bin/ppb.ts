#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { defineCommand, runMain } from 'citty';
import { config as loadDotenv } from 'dotenv';

import { createPgliteAdapter, type PgliteAdapter, pushSchema, resetSchema } from '../src/index.ts';

loadDotenv();

/**
 * Map a DATABASE_URL of the form `pglite://...` to a PGlite dataDir argument.
 *
 * - `pglite://memory` → `undefined` (in-memory PGlite).
 * - `pglite:///abs/path` or `pglite://./relative/path` → the path. PGlite
 *   accepts both absolute paths and `./relative` forms.
 *
 * Returns `undefined` when no DATABASE_URL is set.
 */
const parseDatabaseUrl = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== 'pglite:') {
    throw new Error(`Unsupported DATABASE_URL scheme '${url.protocol}'. Expected 'pglite:'.`);
  }
  if (url.host === 'memory' && (url.pathname === '' || url.pathname === '/')) {
    return undefined;
  }
  // pglite://./rel/path → host = '.', pathname = '/rel/path'
  // pglite:///abs/path  → host = '',  pathname = '/abs/path'
  if (url.host === '.') return `.${url.pathname}`;
  return url.pathname || undefined;
};

const resolveDataDir = (cliFlag: string | undefined): string | undefined =>
  cliFlag ?? parseDatabaseUrl(process.env.DATABASE_URL);

const withAdapter = async <T>(
  dataDir: string | undefined,
  fn: (adapter: PgliteAdapter) => Promise<T>,
): Promise<T> => {
  const pglite = new PGlite(dataDir);
  await pglite.waitReady;
  const adapter = await createPgliteAdapter({ pglite });
  try {
    return await fn(adapter);
  } finally {
    await adapter.close();
    await pglite.close();
  }
};

const dbPush = defineCommand({
  meta: { name: 'db-push', description: 'Apply a Prisma schema to a PGlite database' },
  args: {
    schema: {
      type: 'string',
      description: 'Path to the Prisma schema file',
      default: 'prisma/schema.prisma',
    },
    'force-reset': {
      type: 'boolean',
      description: 'Drop all schemas before applying',
      default: false,
    },
    'accept-data-loss': {
      type: 'boolean',
      description: 'Apply the schema even when destructive-change warnings are reported',
      default: false,
    },
    'data-dir': {
      type: 'string',
      description: 'PGlite data directory (overrides DATABASE_URL)',
    },
  },
  async run({ args }) {
    const schemaPath = resolve(process.cwd(), args.schema);
    const schema = await readFile(schemaPath, 'utf8');
    const dataDir = resolveDataDir(args['data-dir']);
    const acceptDataLoss = args['accept-data-loss'];

    const result = await withAdapter(dataDir, (adapter) =>
      pushSchema(adapter, {
        schema,
        forceReset: args['force-reset'],
        acceptDataLoss,
        filename: schemaPath,
      }),
    );

    for (const w of result.warnings) {
      process.stderr.write(`\u001b[33mwarning:\u001b[0m ${w}\n`);
    }
    for (const u of result.unexecutable) {
      process.stderr.write(`\u001b[31munexecutable:\u001b[0m ${u}\n`);
    }

    if (result.unexecutable.length > 0) process.exit(1);
    if (result.warnings.length > 0 && !acceptDataLoss) process.exit(1);
  },
});

const dbReset = defineCommand({
  meta: { name: 'db-reset', description: 'Drop all user schemas in the PGlite database' },
  args: {
    'data-dir': {
      type: 'string',
      description: 'PGlite data directory (overrides DATABASE_URL)',
    },
  },
  async run({ args }) {
    const dataDir = resolveDataDir(args['data-dir']);
    await withAdapter(dataDir, (adapter) => resetSchema(adapter));
  },
});

const main = defineCommand({
  meta: {
    name: 'ppb',
    description: 'In-process PGlite bridge — apply or reset a Prisma schema',
  },
  subCommands: { 'db-push': dbPush, 'db-reset': dbReset },
});

await runMain(main);
process.exit(0);
