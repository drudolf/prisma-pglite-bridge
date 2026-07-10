/**
 * Jest setup helper — the Jest counterpart to
 * `prisma-pglite-bridge/vitest`'s {@link setupPGliteBridge}. Collapses the
 * bridge + schema + seed + snapshot + hook boilerplate into one call, wired
 * to Jest's `beforeEach`/`afterAll`.
 *
 * ```typescript
 * // test file, run under Jest's native ESM mode
 * import { PrismaClient } from '@prisma/client';
 * import { setupPGliteBridge } from 'prisma-pglite-bridge/jest';
 *
 * const { prisma } = await setupPGliteBridge({
 *   client: (adapter) => new PrismaClient({ adapter }),
 *   migrations: true, // prisma/migrations via prisma.config.ts discovery
 *   seed: async (prisma) => {
 *     await prisma.tenant.create({ data: { name: 'Acme' } });
 *   },
 * });
 *
 * test('starts from the seeded snapshot', async () => {
 *   expect(await prisma.tenant.count()).toBe(1);
 * });
 * ```
 *
 * The helper registers `beforeEach(() => bridge.resetDb())` and
 * `afterAll(() => bridge.close())`, so every test starts from the seeded
 * snapshot and the WASM instance is released when the file finishes.
 *
 * Requires Jest's native ESM mode (`node --experimental-vm-modules`, or the
 * `--experimental-vm-modules` transform), so the top-level `await` resolves
 * before the suite runs. `@jest/globals` is an optional peer dependency —
 * this module is the only entry point that imports it. Jest has no fixture
 * (`test.extend`) equivalent, so unlike the vitest entry there is no
 * `createBridgeTest`; the hook-based helper is the whole surface. The
 * runner-agnostic core is shared with `prisma-pglite-bridge/vitest`.
 */
import { afterAll, beforeEach } from '@jest/globals';
import {
  assertExactlyOneSchemaSource,
  createBridgeContext,
  type PGliteTestContext,
  type SetupPGliteBridgeOptions,
} from './core.ts';

export type { PGliteTestContext, SetupPGliteBridgeOptions } from './core.ts';

/**
 * Create a seeded, snapshot-backed PGlite test context and (by default)
 * wire it into Jest's lifecycle. See the module docs for the flow.
 *
 * On any failure after the bridge is created (schema apply, seed,
 * snapshot), the bridge is closed before the error propagates — no PGlite
 * instance outlives a failed setup.
 */
export const setupPGliteBridge = async <TClient>(
  options: SetupPGliteBridgeOptions<TClient>,
): Promise<PGliteTestContext<TClient>> => {
  assertExactlyOneSchemaSource('setupPGliteBridge', options);

  const context = await createBridgeContext(options);

  if (options.registerHooks !== false) {
    beforeEach(() => context.bridge.resetDb());
    afterAll(() => context.bridge.close());
  }

  return context;
};
