/**
 * prisma-pglite-bridge/pool/testing — runner-agnostic, Prisma-free pool
 * testing builders (the `/testing` counterpart for drizzle, kysely, knex,
 * typeorm, mikro-orm and raw `pg`).
 *
 * The hook-free core under the `/pool/vitest` and `/pool/jest` helpers,
 * for runners without a fixture layer and for "build once, load per test"
 * across processes: `createPoolTemplate` dumps a set-up + seeded data
 * directory, `loadPoolTemplate` boots a fresh, independent PGlite from it.
 * Nothing here imports `@prisma/*` — the CI purity gate enforces it.
 *
 * @example
 * ```typescript
 * import { createPoolTemplate, loadPoolTemplate } from 'prisma-pglite-bridge/pool/testing';
 *
 * const template = await createPoolTemplate({
 *   setup: async ({ pool }) => { await pool.query('CREATE TABLE users (id serial PRIMARY KEY)'); },
 *   client: (pool) => drizzle(pool),
 * });
 *
 * // per test
 * const { client, close } = await loadPoolTemplate(template, { client: (pool) => drizzle(pool) });
 * try { ... } finally { await close(); }
 * ```
 *
 * @packageDocumentation
 */

export {
  createPoolContext,
  createPoolTemplate,
  type LoadPoolTemplateOptions,
  loadPoolTemplate,
  type PGlitePoolTestContext,
  type PoolContextOptions,
  type PoolTemplate,
  type PoolTemplateOptions,
} from './pool-core.ts';
export type { TemplateCompression } from './template.ts';
