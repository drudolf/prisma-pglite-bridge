/**
 * Jest entry over the pool testing core — the Jest counterpart to
 * `prisma-pglite-bridge/pool/vitest`'s {@link setupPGlitePool}. Collapses
 * the pool + schema-setup + seed + snapshot + hook boilerplate into one
 * call, wired to Jest's `beforeEach`/`afterAll`.
 *
 * Requires Jest's native ESM mode (`node --experimental-vm-modules`), so
 * the top-level `await` resolves before the suite runs. `@jest/globals` is
 * an optional peer dependency — this module and the Prisma `/jest` entry
 * are the only entry points that import it. Jest has no fixture
 * (`test.extend`) equivalent, so unlike the vitest entry there is no
 * `createPoolTest`; the hook-based helper is the whole surface. The
 * runner-agnostic core is shared with `prisma-pglite-bridge/pool/vitest`.
 */
import { afterAll, beforeEach } from '@jest/globals';
import {
  createPoolContext,
  type PGlitePoolTestContext,
  type SetupPGlitePoolOptions,
} from './pool-core.ts';

export type { PGlitePoolTestContext, SetupPGlitePoolOptions } from './pool-core.ts';

/**
 * Create a seeded, snapshot-backed pool test context and (by default)
 * wire it into Jest's lifecycle. See the module docs for the flow.
 *
 * On any failure after the pool is created (setup, client factory, seed,
 * snapshot), the pool — and an internally created PGlite — is closed
 * before the error propagates.
 */
export const setupPGlitePool = async <TClient>(
  options: SetupPGlitePoolOptions<TClient>,
): Promise<PGlitePoolTestContext<TClient>> => {
  const context = await createPoolContext(options);

  if (options.registerHooks !== false) {
    beforeEach(() => context.resetDb());
    afterAll(() => context.close());
  }

  return context;
};
