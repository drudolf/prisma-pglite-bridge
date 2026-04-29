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

export const pushSchema = async (
  target: SchemaTarget,
  options: PushSchemaOptions,
): Promise<PushSchemaResult> => {
  const filename = options.filename ?? 'schema.prisma';
  const { SchemaEngine } = await import('@prisma/schema-engine-wasm');
  const bound = await bindAdapter(target);

  const engine = await SchemaEngine.new(
    { datamodels: [[filename, options.schema]] },
    () => {},
    bound,
  );
  try {
    if (options.forceReset) {
      await engine.reset({ filter: emptyFilter() });
    }
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
  const { SchemaEngine } = await import('@prisma/schema-engine-wasm');
  const bound = await bindAdapter(target);
  const stub = `datasource db { provider = "postgresql" }\n`;
  const engine = await SchemaEngine.new({ datamodels: [['schema.prisma', stub]] }, () => {}, bound);
  try {
    await engine.reset({ filter: emptyFilter() });
  } finally {
    engine.free();
  }
};
