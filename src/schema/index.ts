/**
 * Apply a Prisma schema to a PGlite database in-process via
 * `@prisma/schema-engine-wasm`. No native schema-engine binary, no TCP.
 *
 * `pushSchema` mirrors `prisma db push --skip-generate`: diff the schema
 * against the live database and apply the result. `resetSchema` drops
 * everything reachable through the connection.
 *
 * The schema engine WASM module is dynamically imported so consumers
 * who only use the bridge never load it.
 *
 * @example
 * ```typescript
 * import { PGliteBridge, pushSchema } from 'prisma-pglite-bridge';
 *
 * const bridge = new PGliteBridge();
 *
 * await pushSchema(bridge.adapter, {
 *   schema: await fs.readFile('prisma/schema.prisma', 'utf8'),
 * });
 *
 * // teardown
 * await bridge.close(); // closes pool + pglite (bridge owns it)
 * ```
 */
import type { PrismaPg } from '@prisma/adapter-pg';
import { quoteIdent } from '../utils/quote-ident.ts';
import { wrapFactoryForPg18 } from './pg18-not-null.ts';

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

const bindAdapter = async (adapter: PrismaPg): Promise<object> => {
  const { bindMigrationAwareSqlAdapterFactory } = await import('@prisma/driver-adapter-utils');
  // wrapFactoryForPg18 shields the engine from PostgreSQL 18's contype 'n'
  // rows, which panic its constraint introspection — see pg18-not-null.ts.
  return bindMigrationAwareSqlAdapterFactory(wrapFactoryForPg18(adapter));
};

const emptyFilter = (): { externalTables: string[]; externalEnums: string[] } => ({
  externalTables: [],
  externalEnums: [],
});

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
const dropAllUserSchemas = async (adapter: PrismaPg): Promise<void> => {
  const conn = await adapter.connect();
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
};

export const pushSchema = async (
  adapter: PrismaPg,
  options: PushSchemaOptions,
): Promise<PushSchemaResult> => {
  const filename = options.filename ?? 'schema.prisma';
  if (options.forceReset) {
    await dropAllUserSchemas(adapter);
  }
  const { SchemaEngine } = await import('@prisma/schema-engine-wasm');
  const bound = await bindAdapter(adapter);

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

export const resetSchema = async (adapter: PrismaPg): Promise<void> => {
  await dropAllUserSchemas(adapter);
};
