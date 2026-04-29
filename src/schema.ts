/**
 * Apply a Prisma schema to a PGlite database in-process via
 * `@prisma/schema-engine-wasm`. No native schema-engine binary, no TCP.
 *
 * `pushSchema` mirrors `prisma db push --skip-generate`: diff the schema
 * against the live database and apply the result. `resetSchema` drops
 * everything reachable through the connection.
 *
 * The schema engine WASM module is dynamically imported so consumers
 * who only use the adapter never load it.
 *
 * @example
 * ```typescript
 * import { PGlite } from '@electric-sql/pglite';
 * import { createPgliteAdapter, pushSchema } from 'prisma-pglite-bridge';
 *
 * const pglite = new PGlite();
 * const adapter = await createPgliteAdapter({ pglite });
 *
 * await pushSchema(adapter, {
 *   schema: await fs.readFile('prisma/schema.prisma', 'utf8'),
 * });
 * ```
 */
import type { PrismaPg } from '@prisma/adapter-pg';

import type { PgliteAdapter } from './create-pglite-adapter.ts';

/** A target database adapter. Either the wrapper from {@link createPgliteAdapter} or a raw {@link PrismaPg}. */
export type SchemaTarget = PgliteAdapter | PrismaPg;

export interface PushSchemaOptions {
  /** Inline Prisma schema source. */
  schema: string;
  /**
   * Drop everything reachable through the adapter before applying.
   * Issued as a separate `engine.reset(...)` call. Distinct from
   * {@link acceptDataLoss}. Default: `false`.
   */
  forceReset?: boolean;
  /**
   * Forwarded to `SchemaPushInput.force`. Apply the schema even when
   * the engine reports destructive-change warnings. Has no effect on
   * `unexecutable` steps. Default: `false`.
   */
  acceptDataLoss?: boolean;
  /** Logical filename used in schema-engine error messages. Default: `'schema.prisma'`. */
  filename?: string;
}

export interface PushSchemaResult {
  /** Number of migration steps the engine applied. */
  executedSteps: number;
  /**
   * Destructive-change warnings reported by the engine. Suppressed
   * (i.e. applied anyway) when {@link PushSchemaOptions.acceptDataLoss} is true.
   */
  warnings: string[];
  /**
   * Steps the engine refused to run regardless of `acceptDataLoss`.
   * The caller must reshape the schema (e.g. add a default value) and retry.
   */
  unexecutable: string[];
}

const unwrap = (target: SchemaTarget): PrismaPg =>
  'adapter' in target ? (target.adapter as PrismaPg) : target;

const bindAdapter = async (target: SchemaTarget): Promise<object> => {
  const { bindMigrationAwareSqlAdapterFactory } = await import('@prisma/driver-adapter-utils');
  return bindMigrationAwareSqlAdapterFactory(unwrap(target));
};

const emptyFilter = (): { externalTables: string[]; externalEnums: string[] } => ({
  externalTables: [],
  externalEnums: [],
});

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * Drop every non-system schema (and recreate `public`). Issued as raw SQL
 * through the adapter rather than `engine.reset(...)` because the engine only
 * clears schemas declared in its datamodel — anything outside that (`base`,
 * test fixtures, etc.) would otherwise leak between resets.
 *
 * Each DROP runs through `executeRaw` rather than a single `executeScript`,
 * because `executeScript` splits on `;` and would mis-parse schema names that
 * contain a semicolon.
 */
const dropAllUserSchemas = async (target: SchemaTarget): Promise<void> => {
  const factory = unwrap(target);
  const conn = await factory.connect();
  try {
    const result = await conn.queryRaw({
      sql: `SELECT nspname FROM pg_namespace
            WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'`,
      args: [],
      argTypes: [],
    });
    const idx = result.columnNames.indexOf('nspname');
    const names = result.rows.map((row) => String(row[idx]));
    for (const name of names) {
      await conn.executeRaw({
        sql: `DROP SCHEMA IF EXISTS ${quoteIdent(name)} CASCADE`,
        args: [],
        argTypes: [],
      });
    }
    await conn.executeRaw({
      sql: `CREATE SCHEMA IF NOT EXISTS "public"`,
      args: [],
      argTypes: [],
    });
  } finally {
    await conn.dispose();
  }
  // The wrapper's snapshot manager keeps in-memory state about whether
  // `_pglite_snapshot` exists. Dropping the schema out from under it would
  // leave `hasSnapshot = true` and the next `resetDb()` call would query a
  // missing schema. `resetSnapshot()` is idempotent — safe to call when no
  // snapshot was ever taken.
  if ('resetSnapshot' in target) {
    await target.resetSnapshot();
  }
};

export const pushSchema = async (
  target: SchemaTarget,
  options: PushSchemaOptions,
): Promise<PushSchemaResult> => {
  const filename = options.filename ?? 'schema.prisma';
  if (options.forceReset) {
    await dropAllUserSchemas(target);
  }
  const { SchemaEngine } = await import('@prisma/schema-engine-wasm');
  const bound = await bindAdapter(target);

  const engine = await SchemaEngine.new(
    { datamodels: [[filename, options.schema]] },
    () => {},
    bound,
  );
  try {
    const result = await engine.schemaPush({
      force: options.acceptDataLoss ?? false,
      schema: { files: [{ path: filename, content: options.schema }] },
      filters: emptyFilter(),
    });
    return {
      executedSteps: result.executedSteps,
      warnings: result.warnings,
      unexecutable: result.unexecutable,
    };
  } finally {
    engine.free();
  }
};

export const resetSchema = async (target: SchemaTarget): Promise<void> => {
  await dropAllUserSchemas(target);
};
