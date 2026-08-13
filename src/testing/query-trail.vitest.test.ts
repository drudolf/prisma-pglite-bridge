/**
 * Helper-integration tests for the on-failure query trail, Prisma-bridge
 * variant (design: .claude/plans/query-trail-design.md §5). Mirrors the pool
 * variant (`./query-trail.pool-vitest.test.ts`) but exercises
 * `createBridgeTest` / `setupPGliteBridge`, whose fixture exposes `bridge`.
 *
 * The bridge's app-facing surface is a Prisma driver adapter, so captured
 * traffic here is driven through the adapter's public
 * `connect().queryRaw({ sql, args, argTypes })` path — a stable
 * `@prisma/driver-adapter-utils` shape — rather than a generated
 * `@prisma/client` (which the bridge deliberately cannot import). That query
 * still lands at `PgBridgeClient.query()`, where the trail captures it.
 *
 * As in the pool variant, failure-printout behavior is observed via hermetic
 * child `vitest run`s; the accessor-path test at the bottom is in-process.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { formatQueryTrail } from '../pool/query-trail-format.ts';
import { setupPGliteBridge } from './vitest.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'vitest');
const BRIDGE_VITEST_SRC = join(REPO_ROOT, 'src', 'testing', 'vitest.ts');

interface ChildRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** See `query-trail.pool-vitest.test.ts` for the harness rationale. */
const runChildSpec = async (specSource: string, env: NodeJS.ProcessEnv = {}): Promise<ChildRun> => {
  const dir = await mkdtemp(join(tmpdir(), 'ppb-trail-bridge-'));
  try {
    await writeFile(join(dir, 'child.spec.ts'), specSource, 'utf8');
    const configSource = `import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    root: ${JSON.stringify(REPO_ROOT)},
    include: [${JSON.stringify(join(dir, 'child.spec.ts'))}],
    hookTimeout: 60_000,
    testTimeout: 60_000,
    coverage: { enabled: false },
  },
});
`;
    await writeFile(join(dir, 'vitest.config.ts'), configSource, 'utf8');
    return await new Promise<ChildRun>((resolve, reject) => {
      const child = spawn(
        VITEST_BIN,
        ['run', '--config', join(dir, 'vitest.config.ts'), '--reporter=dot'],
        { cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString('utf8');
      });
      child.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`child vitest run timed out\nstderr:\n${stderr}`));
      }, 120_000);
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const output = (run: ChildRun): string => `${run.stdout}\n${run.stderr}`;
const TRAIL_HEADER = 'pglite-bridge query trail —';

/**
 * A `createBridgeTest` child spec: an inline schema with a `Widget` model and
 * a client factory that opens one adapter connection, so tests can drive raw
 * captured SQL through `client.conn.queryRaw(...)`.
 */
const bridgeSpec = (opts: { queryTrailOption?: string; body: string }): string => `
import { expect } from 'vitest';
import { createBridgeTest } from ${JSON.stringify(BRIDGE_VITEST_SRC)};

const test = createBridgeTest({
  ${opts.queryTrailOption ?? ''}
  schema: { schema: 'model Widget {\\n  id Int @id @default(autoincrement())\\n  label String\\n}' },
  client: (adapter) => ({ conn: adapter.connect() }),
});

${opts.body}
`;

describe('query trail (bridge) — default ON prints the failing test’s trail', () => {
  it('prints the header and that test’s own query on failure', async () => {
    const run = await runChildSpec(
      bridgeSpec({
        body: `
test('B fails after a raw insert', async ({ prisma }) => {
  const conn = await prisma.conn;
  await conn.executeRaw({
    sql: "INSERT INTO \\"Widget\\" (label) VALUES ($1)",
    args: ['BRIDGE_UNIQUE_QUERY'],
    argTypes: [{ scalarType: 'string', arity: 'scalar' }],
  });
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(run.code).not.toBe(0);
    expect(out).toContain(TRAIL_HEADER);
    expect(out).toContain('BRIDGE_UNIQUE_QUERY');
  }, 130_000);
});

describe('query trail (bridge) — queryTrail: false suppresses the printout', () => {
  it('a failing test prints no trail when opted out', async () => {
    const run = await runChildSpec(
      bridgeSpec({
        queryTrailOption: 'queryTrail: false,',
        body: `
test('B fails with the trail disabled', async ({ prisma }) => {
  const conn = await prisma.conn;
  await conn.executeRaw({
    sql: "INSERT INTO \\"Widget\\" (label) VALUES ($1)",
    args: ['BRIDGE_OPTED_OUT'],
    argTypes: [{ scalarType: 'string', arity: 'scalar' }],
  });
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(run.code).not.toBe(0);
    expect(out).not.toContain(TRAIL_HEADER);
  }, 130_000);
});

// ── Accessor path (in-process) — bridge.queryTrail() + formatQueryTrail ──
const accessorCtx = await setupPGliteBridge({
  registerHooks: false,
  bridge: { queryTrail: true },
  schema: { schema: 'model Widget {\n  id Int @id @default(autoincrement())\n  label String\n}' },
  client: (adapter) => ({ conn: adapter.connect() }),
});

afterAll(() => accessorCtx.bridge.close());

describe('query trail (bridge) — accessor path', () => {
  it('bridge.queryTrail() returns the entries and formatQueryTrail renders the header', async () => {
    accessorCtx.bridge.clearQueryTrail();
    const conn = await accessorCtx.prisma.conn;
    await conn.executeRaw({
      sql: 'INSERT INTO "Widget" (label) VALUES ($1)',
      args: ['ACCESSOR_LABEL'],
      argTypes: [{ scalarType: 'string', arity: 'scalar' }],
    });
    const entries = accessorCtx.bridge.queryTrail();
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.some((e) => e.sql.includes('Widget'))).toBe(true);
    const rendered = formatQueryTrail(entries, { droppedCount: 0 });
    expect(rendered.startsWith(TRAIL_HEADER)).toBe(true);
  });
});
