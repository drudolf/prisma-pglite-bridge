/**
 * Helper-integration tests for the on-failure query trail, pool variant
 * (design: .claude/plans/query-trail-design.md §5, §7 "Helper
 * integration" / "Lifecycle pin"). These run against REAL PGlite bridges.
 *
 * Why child vitest runs: the trail's headline behavior is a side effect of
 * `onTestFailed` firing when a test genuinely fails and printing to stderr.
 * That cannot be observed from a passing in-process test, so — as pg
 * ecosystem helper suites do — each scenario is a tiny spec file executed by
 * a spawned `vitest run`, whose stderr we capture and assert on. The repo
 * already spawns child processes in tests (`src/__tests__/cli-compat/utils/
 * run-cli.ts`); this file follows that pattern, hermetically: every run gets
 * its own temp dir under `os.tmpdir()`, wiped in a `finally`.
 *
 * The accessor-path test at the bottom needs no child run — it asserts the
 * structured `pool.queryTrail()` + `formatQueryTrail` API in-process, which
 * is the Jest/standalone story from §5.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { formatQueryTrail } from '../pool/query-trail-format.ts';
import { setupPGlitePool } from './pool-vitest.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VITEST_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'vitest');
// Absolute source specifier the child spec imports — the local, unbuilt
// helper (NOT the stale `dist` the package `exports` map points at).
const POOL_VITEST_SRC = join(REPO_ROOT, 'src', 'testing', 'pool-vitest.ts');

interface ChildRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Write `specSource` into a fresh temp dir, run it under a standalone vitest
 * config rooted at the repo (so `node_modules` and local source resolve),
 * capture stdout/stderr, and clean up. `env` is merged over the parent env —
 * pass `PGLITE_BRIDGE_QUERY_TRAIL` / `PGLITE_BRIDGE_TRAIL_FORMAT` here.
 */
const runChildSpec = async (specSource: string, env: NodeJS.ProcessEnv = {}): Promise<ChildRun> => {
  const dir = await mkdtemp(join(tmpdir(), 'ppb-trail-'));
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

/** Combined child output — the trail may land on either stream depending on
 *  vitest's reporter interleaving; assertions search both. */
const output = (run: ChildRun): string => `${run.stdout}\n${run.stderr}`;

const TRAIL_HEADER = 'pglite-bridge query trail —';

/**
 * A child spec header shared by the pool scenarios: builds a `createPoolTest`
 * with a `notes` table and (optionally) a seed, exposing `pool` for direct
 * `pool.query` traffic. `body` supplies the test(s) under `const test = ...`.
 */
const poolSpec = (opts: {
  queryTrailOption?: string; // e.g. "queryTrail: false," — spliced into options
  scope?: "'test'" | "'file'" | "'worker'";
  seed?: boolean;
  body: string;
}): string => `
import { expect } from 'vitest';
import { createPoolTest } from ${JSON.stringify(POOL_VITEST_SRC)};

const test = createPoolTest({
  ${opts.scope ? `scope: ${opts.scope},` : ''}
  ${opts.queryTrailOption ?? ''}
  setup: async ({ pool }) => {
    await pool.query('CREATE TABLE notes (id serial PRIMARY KEY, body text NOT NULL)');
  },
  client: (pool) => ({ pool }),
  ${
    opts.seed
      ? `seed: async ({ pool }) => {
    await pool.query("INSERT INTO notes (body) VALUES ('SEED_MARKER_ROW')");
  },`
      : ''
  }
});

${opts.body}
`;

describe('query trail — default ON, failing test prints its trail', () => {
  it('prints the header and the failing test’s own queries to the child output', async () => {
    const run = await runChildSpec(
      poolSpec({
        body: `
test('B fails after issuing a unique query', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('UNIQUE_B_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    // The failing test triggered the trail printout.
    expect(out).toContain(TRAIL_HEADER);
    // …and it contains that test's own query.
    expect(out).toContain('UNIQUE_B_QUERY');
    // The child suite genuinely failed (proves onTestFailed had cause to fire).
    expect(run.code).not.toBe(0);
  }, 130_000);
});

describe('query trail — scoped to the failing test only ([tribunal] clear-at-start)', () => {
  it('scope file: B’s printout has B’s queries, not A’s, and passing A prints nothing', async () => {
    const run = await runChildSpec(
      poolSpec({
        scope: "'file'",
        body: `
test('A passes after issuing its own query', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('QUERY_FROM_A')");
  expect(1).toBe(1);
});

test('B fails after issuing its own query', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('QUERY_FROM_B')");
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(out).toContain(TRAIL_HEADER);
    // The printed (failing) trail carries B's query…
    expect(out).toContain('QUERY_FROM_B');
    // …and NOT A's — the trail was cleared at B's start, so A's traffic is gone.
    expect(out).not.toContain('QUERY_FROM_A');
  }, 130_000);

  it('[tribunal] reset/seed traffic never pollutes the failing test’s trail', async () => {
    const run = await runChildSpec(
      poolSpec({
        scope: "'file'",
        seed: true,
        body: `
test('B fails; its trail must exclude the seed INSERT', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('POST_RESET_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(out).toContain(TRAIL_HEADER);
    expect(out).toContain('POST_RESET_QUERY');
    // The seed's INSERT ran before the per-test clear — it must not appear.
    expect(out).not.toContain('SEED_MARKER_ROW');
  }, 130_000);
});

describe('query trail — scope test contains exactly the failing test’s queries', () => {
  it('scope test: the trail has the test’s own query', async () => {
    const run = await runChildSpec(
      poolSpec({
        scope: "'test'",
        body: `
test('isolated test fails after its own query', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('ISO_TEST_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(out).toContain(TRAIL_HEADER);
    expect(out).toContain('ISO_TEST_QUERY');
  }, 130_000);
});

describe('query trail — passing runs print nothing', () => {
  it('a wholly-passing child run emits no trail header', async () => {
    const run = await runChildSpec(
      poolSpec({
        body: `
test('A passes', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('PASSING_ONLY')");
  expect(1).toBe(1);
});
`,
      }),
    );
    const out = output(run);
    expect(run.code).toBe(0);
    expect(out).not.toContain(TRAIL_HEADER);
  }, 130_000);
});

describe('query trail — opt-outs suppress capture and printout', () => {
  it('queryTrail: false → no printout even when a test fails', async () => {
    const run = await runChildSpec(
      poolSpec({
        queryTrailOption: 'queryTrail: false,',
        body: `
test('B fails with the trail disabled by option', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('OPTED_OUT_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(run.code).not.toBe(0); // still failed…
    expect(out).not.toContain(TRAIL_HEADER); // …but printed no trail.
  }, 130_000);

  it('PGLITE_BRIDGE_QUERY_TRAIL=0 → no printout, overriding queryTrail: true ([tribunal] env kill switch wins)', async () => {
    const run = await runChildSpec(
      poolSpec({
        queryTrailOption: 'queryTrail: true,',
        body: `
test('B fails but the env kill switch is set', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('ENV_KILLED_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
      { PGLITE_BRIDGE_QUERY_TRAIL: '0' },
    );
    const out = output(run);
    expect(run.code).not.toBe(0);
    expect(out).not.toContain(TRAIL_HEADER);
  }, 130_000);
});

describe('query trail — JSONL switch', () => {
  it('PGLITE_BRIDGE_TRAIL_FORMAT=json → the printout is JSONL whose first line is a trail-header event', async () => {
    const run = await runChildSpec(
      poolSpec({
        body: `
test('emits JSONL on failure', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('JSONL_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
      { PGLITE_BRIDGE_TRAIL_FORMAT: 'json' },
    );
    const out = output(run);
    // The human header prose must NOT appear in JSON mode.
    expect(out).not.toContain(TRAIL_HEADER);
    // Find a line that parses to the trail-header event carrying the test name.
    const headerLine = out
      .split('\n')
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      })
      .find((obj) => obj?.type === 'trail-header');
    expect(headerLine).toBeDefined();
    expect(headerLine?.formatVersion).toBe(1);
    expect(headerLine?.testName).toContain('emits JSONL on failure');
  }, 130_000);
});

describe('query trail — [tribunal] lifecycle: captured before teardown, pending rendered', () => {
  it('the printout survives even though resetDb/teardown runs after the failure', async () => {
    // If the trail were read AFTER teardown, the reset would have cleared it
    // and the header/queries would be gone. Their presence pins capture-first.
    const run = await runChildSpec(
      poolSpec({
        scope: "'file'",
        body: `
test('captured before teardown', async ({ pool }) => {
  await pool.query("INSERT INTO notes (body) VALUES ('BEFORE_TEARDOWN_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(out).toContain(TRAIL_HEADER);
    expect(out).toContain('BEFORE_TEARDOWN_QUERY');
  }, 130_000);

  it('an in-flight (un-awaited) query at failure time renders with the pending marker', async () => {
    const run = await runChildSpec(
      poolSpec({
        body: `
test('fires a query then fails before it settles', async ({ pool }) => {
  // Do NOT await: the assertion fails while the query is still in flight, so
  // onTestFailed reads a 'pending' entry.
  void pool.query("INSERT INTO notes (body) VALUES ('IN_FLIGHT_QUERY')");
  expect(1).toBe(2);
});
`,
      }),
    );
    const out = output(run);
    expect(out).toContain(TRAIL_HEADER);
    // The pending marker from the human formatter appears for the in-flight row.
    expect(out).toContain('pending');
    expect(out).toContain('IN_FLIGHT_QUERY');
  }, 130_000);
});

// ── Accessor path (in-process, no child run) — the Jest/standalone story ──
const accessorCtx = await setupPGlitePool({
  registerHooks: false,
  pool: { queryTrail: true },
  setup: async ({ pool }) => {
    await pool.query('CREATE TABLE acc_notes (id serial PRIMARY KEY, body text NOT NULL)');
  },
  client: (pool) => ({ pool }),
});

afterAll(() => accessorCtx.close());

describe('query trail — accessor path (pool.queryTrail + formatQueryTrail)', () => {
  it('pool.queryTrail() returns structured entries a test can assert on', async () => {
    accessorCtx.pool.clearQueryTrail();
    await accessorCtx.pool.query("INSERT INTO acc_notes (body) VALUES ('ACCESSOR_ROW')");
    const entries = accessorCtx.pool.queryTrail();
    expect(Array.isArray(entries)).toBe(true);
    const insert = entries.find((e) => e.sql.includes('acc_notes'));
    expect(insert).toBeDefined();
    expect(insert?.kind).toBe('query');
    expect(insert?.status).toBe('settled');
  });

  it('formatQueryTrail over the accessor entries produces the human header', async () => {
    accessorCtx.pool.clearQueryTrail();
    await accessorCtx.pool.query('SELECT 1');
    const entries = accessorCtx.pool.queryTrail();
    const rendered = formatQueryTrail(entries, { droppedCount: 0 });
    expect(rendered.startsWith(TRAIL_HEADER)).toBe(true);
  });
});
