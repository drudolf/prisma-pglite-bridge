#!/usr/bin/env tsx
/**
 * Per-test isolation cost benchmark.
 *
 * A test suite pays a database-isolation cost on every test. This measures
 * that cost for the three strategies `createBridgeTest` offers, using the
 * library's real code paths and the realistic integration seed:
 *
 *   - cold start   — a fresh bridge + migrations + seed per test. The naive
 *                    (pre-1.6) `scope: 'test'` cost.
 *   - snapshot     — one shared bridge, `resetDb()` before each test. What
 *                    `scope: 'file'` / `'worker'` pay per test. Cheapest, but
 *                    all tests share one single-session PGlite.
 *   - template     — build one template per file, then load a fresh,
 *                    independent PGlite from it per test. The 1.6 `scope:
 *                    'test'` path: concurrent-safe isolation without the full
 *                    cold start each time.
 *
 * The per-test figure is what each strategy adds per test: cold start and
 * template create + tear down an instance every test, so their figure is the
 * full lifecycle; snapshot reuses one bridge, so its figure is just the reset.
 * One-time costs (paid once per file) are reported separately.
 *
 * Usage:
 *   pnpm bench:isolation                # 20 iterations
 *   pnpm bench:isolation -n 40
 *   pnpm bench:isolation --json
 */
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { seed } from '../src/__tests__/integration/utils/seed.ts';
import { PGliteBridge, pushMigrations } from '../src/index.ts';
import { createBridgeContextFromDump, createBridgeTemplate } from '../src/testing/core.ts';

const repoRoot = join(import.meta.dirname, '..');
const client = (adapter: PrismaPg): PrismaClient => new PrismaClient({ adapter });

// ─── CLI ───
const args = process.argv.slice(2);
const getArg = (name: string, short?: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  if (short) {
    const s = args.indexOf(`-${short}`);
    if (s >= 0) return args[s + 1];
  }
  return undefined;
};
const iterations = Number(getArg('iterations', 'n') ?? '20');
const jsonOutput = args.includes('--json');

// ─── Stats ───
const now = () => performance.now();
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const pct = (a: number[], p: number) => {
  const s = sorted(a);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};
const fmt = (ms: number) => (ms < 1000 ? `${ms.toFixed(1)}ms` : `${(ms / 1000).toFixed(2)}s`);

// ─── Strategies ───

// cold start: full lifecycle per test (create + tear down).
const coldStartOnce = async (): Promise<void> => {
  const bridge = new PGliteBridge();
  await pushMigrations(bridge.pglite, { configRoot: repoRoot });
  const prisma = client(bridge.adapter);
  await seed(prisma);
  await prisma.$disconnect();
  await bridge.close();
};

const measureColdStart = async (n: number): Promise<number[]> => {
  await coldStartOnce(); // warmup: compiles the PGlite WASM module for the process
  const times: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    await coldStartOnce();
    times.push(now() - t0);
  }
  return times;
};

// snapshot: one bridge built once, resetDb() before each test.
const measureSnapshot = async (n: number): Promise<{ perTest: number[]; oneTime: number }> => {
  const o0 = now();
  const bridge = new PGliteBridge();
  await pushMigrations(bridge.pglite, { configRoot: repoRoot });
  const prisma = client(bridge.adapter);
  await seed(prisma);
  await bridge.snapshotDb();
  const oneTime = now() - o0;

  const perTest: number[] = [];
  for (let i = 0; i < n + 1; i++) {
    // A realistic test mutates state; the reset has to restore the snapshot.
    await prisma.tenant.create({ data: { name: `probe-${i}`, slug: `probe-${i}` } });
    const t0 = now();
    await bridge.resetDb();
    if (i > 0) perTest.push(now() - t0); // drop the first as warmup
  }

  await prisma.$disconnect();
  await bridge.close();
  return { perTest, oneTime };
};

// template: build + dump once, load a fresh instance per test.
const measureTemplate = async (n: number): Promise<{ perTest: number[]; oneTime: number }> => {
  const o0 = now();
  const dump = await createBridgeTemplate({ client, migrations: { configRoot: repoRoot }, seed });
  const oneTime = now() - o0;

  const loadOnce = async (): Promise<void> => {
    const ctx = await createBridgeContextFromDump(dump, { client });
    await ctx.prisma.tenant.count(); // force the load + WASM boot
    await ctx.prisma.$disconnect();
    await ctx.close();
  };

  await loadOnce(); // warmup
  const perTest: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    await loadOnce();
    perTest.push(now() - t0);
  }
  return { perTest, oneTime };
};

// ─── Run ───

const cold = await measureColdStart(iterations);
const snap = await measureSnapshot(iterations);
const tmpl = await measureTemplate(iterations);

const rows = [
  { strategy: 'cold start', scope: 'test (pre-1.6)', perTest: cold, oneTime: 0 },
  {
    strategy: 'snapshot reset',
    scope: 'file / worker',
    perTest: snap.perTest,
    oneTime: snap.oneTime,
  },
  { strategy: 'template load', scope: 'test (1.6+)', perTest: tmpl.perTest, oneTime: tmpl.oneTime },
];

const machine = {
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpus: cpus().length,
};

if (jsonOutput) {
  console.log(
    JSON.stringify(
      {
        benchmark: 'isolation-cost',
        iterations,
        machine,
        results: rows.map((r) => ({
          strategy: r.strategy,
          scope: r.scope,
          oneTimeMs: r.oneTime,
          perTest: { p50: pct(r.perTest, 50), p90: pct(r.perTest, 90), p99: pct(r.perTest, 99) },
        })),
      },
      null,
      2,
    ),
  );
} else {
  console.log(
    `\nPer-test isolation cost — ${machine.platform}/${machine.arch}, ` +
      `${machine.cpus} cores, Node ${machine.node}, n=${iterations} (post-warmup)\n`,
  );
  const pad = (s: string, w: number) => s.padEnd(w);
  const padL = (s: string, w: number) => s.padStart(w);
  console.log(
    `${pad('strategy', 16)}${pad('scope', 18)}${padL('per-test p50', 14)}${padL('p90', 10)}${padL('p99', 10)}${padL('one-time', 12)}`,
  );
  console.log('─'.repeat(80));
  for (const r of rows) {
    console.log(
      pad(r.strategy, 16) +
        pad(r.scope, 18) +
        padL(fmt(pct(r.perTest, 50)), 14) +
        padL(fmt(pct(r.perTest, 90)), 10) +
        padL(fmt(pct(r.perTest, 99)), 10) +
        padL(r.oneTime ? fmt(r.oneTime) : '—', 12),
    );
  }
  console.log(
    '\nper-test = what each strategy adds per test (cold start & template are ' +
      'full create+teardown;\nsnapshot is the reset only). one-time = paid once ' +
      'per file (shared bridge build / template build+dump).\n',
  );
}
