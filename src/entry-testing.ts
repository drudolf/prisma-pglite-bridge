/**
 * prisma-pglite-bridge/testing — runner-agnostic Prisma testing builders.
 *
 * The hook-free core under the `/vitest` and `/jest` helpers, for runners
 * without a fixture layer (node:test, ava, a vitest `globalSetup`) and for
 * "build once, load per test" across processes: `createBridgeTemplate`
 * dumps a migrated + seeded data directory, `loadBridgeTemplate` boots a
 * fresh, independent PGlite from it in a fraction of the cold-start cost —
 * in this process or, via a file, in another.
 *
 * @example
 * ```typescript
 * import { PrismaClient } from '@prisma/client';
 * import { createBridgeTemplate, loadBridgeTemplate } from 'prisma-pglite-bridge/testing';
 *
 * const client = (adapter) => new PrismaClient({ adapter });
 * const template = await createBridgeTemplate({ client, migrations: true, seed });
 *
 * // per test
 * const { prisma, close } = await loadBridgeTemplate(template, { client });
 * try { ... } finally { await close(); }
 * ```
 *
 * @packageDocumentation
 */

export {
  type BridgeContext,
  type BridgeContextOptions,
  type BridgeTemplate,
  type BridgeTemplateOptions,
  createBridgeContext,
  createBridgeTemplate,
  type LoadBridgeTemplateOptions,
  loadBridgeTemplate,
} from './testing/core.ts';
export type { TemplateCompression } from './testing/template.ts';
