/**
 * On-failure query-trail overhead benchmark (design:
 * .claude/plans/query-trail-design.md §6/§7). The trail renders a few bounded
 * strings per query in helper-driven test runs; this measures whether that
 * cost clears the default-ON bar: <2% at p50 AND <0.05 ms absolute per query.
 *
 * Two scenarios, each run trail-OFF then trail-ON on identical PGlite state:
 *   - read: a findmany-shaped SELECT with a WHERE param (point-lookup);
 *   - write: an 8-column INSERT with realistic params (the trail's per-param
 *     preview cost scales with param count, so a wide insert is the stress).
 * ≥5 repetitions with warmup; p50 and p99 per scenario; % and absolute-ms
 * deltas. Machine-readable summary lines (`SUMMARY … json`) close the run.
 *
 * Run: pnpm bench:trail
 */
import { PGlite } from '@electric-sql/pglite';
import { PgBridgePool } from '../src/pool/index.ts';

const WARMUP = 500;
const MEASURE = 5000;
const REPS = 5;

const pct = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? Number.NaN;

interface ScenarioResult {
  p50: number;
  p99: number;
}

/** One measured pass over `op`, returning per-call p50/p99 in ms. */
const measure = async (op: () => Promise<unknown>): Promise<ScenarioResult> => {
  for (let i = 0; i < WARMUP; i++) await op();
  const timings: number[] = [];
  for (let i = 0; i < MEASURE; i++) {
    const start = performance.now();
    await op();
    timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  return { p50: pct(timings, 50), p99: pct(timings, 99) };
};

/** Median of a rep set — the stable per-scenario figure. */
const median = (xs: number[]): number =>
  [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

/** Build a pool on a fresh PGlite seeded with the bench table + rows, run both
 *  scenarios, tear down. `queryTrail` toggles the feature under test. */
const runVariant = async (
  queryTrail: boolean,
): Promise<{ read: ScenarioResult; write: ScenarioResult }> => {
  const pglite = new PGlite();
  await pglite.waitReady;
  const pool = new PgBridgePool({ pglite, queryTrail });
  try {
    await pool.query(
      `CREATE TABLE bench_events (
        id serial PRIMARY KEY, tenant_id int NOT NULL, kind text NOT NULL,
        payload text NOT NULL, amount numeric NOT NULL, priority int NOT NULL,
        created_at timestamptz NOT NULL, actor text NOT NULL, note text NOT NULL
      )`,
    );
    for (let i = 0; i < 2000; i++) {
      await pool.query(
        `INSERT INTO bench_events
           (tenant_id, kind, payload, amount, priority, created_at, actor, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          i % 20,
          'seed',
          `payload-${i}`,
          i * 1.5,
          i % 5,
          new Date().toISOString(),
          `actor-${i}`,
          'seed row',
        ],
      );
    }

    // read: findmany-shaped point lookup — SELECT … WHERE tenant_id = $1 LIMIT.
    let readSeed = 0;
    const read = await measure(() =>
      pool.query(
        'SELECT id, kind, payload, amount FROM bench_events WHERE tenant_id = $1 ORDER BY id LIMIT 20',
        [readSeed++ % 20],
      ),
    );

    // write: 8-column INSERT with realistic params (max per-param preview cost).
    let writeSeed = 0;
    const write = await measure(() => {
      const n = writeSeed++;
      return pool.query(
        `INSERT INTO bench_events
           (tenant_id, kind, payload, amount, priority, created_at, actor, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          n % 20,
          'write',
          `payload-${n}`,
          n * 1.5,
          n % 5,
          new Date().toISOString(),
          `actor-${n}`,
          'bench insert row',
        ],
      );
    });

    return { read, write };
  } finally {
    await pool.end();
    if (!pglite.closed) await pglite.close();
  }
};

const scenarios = ['read', 'write'] as const;
type Scenario = (typeof scenarios)[number];

const off: Record<Scenario, ScenarioResult[]> = { read: [], write: [] };
const on: Record<Scenario, ScenarioResult[]> = { read: [], write: [] };

for (let rep = 0; rep < REPS; rep++) {
  // OFF then ON, interleaved per rep, so drift affects both variants alike.
  const offRep = await runVariant(false);
  const onRep = await runVariant(true);
  for (const s of scenarios) {
    off[s].push(offRep[s]);
    on[s].push(onRep[s]);
  }
}

console.log(`\nquery-trail overhead — node ${process.version}, reps ${REPS}, ${MEASURE} ops/rep\n`);
console.log(
  `${'scenario'.padEnd(8)}${'off p50'.padStart(12)}${'on p50'.padStart(12)}${'Δ p50'.padStart(12)}${'Δ%'.padStart(9)}${'off p99'.padStart(12)}${'on p99'.padStart(12)}${'Δ p99'.padStart(12)}`,
);

const summary: Record<string, unknown>[] = [];
for (const s of scenarios) {
  const offP50 = median(off[s].map((r) => r.p50));
  const onP50 = median(on[s].map((r) => r.p50));
  const offP99 = median(off[s].map((r) => r.p99));
  const onP99 = median(on[s].map((r) => r.p99));
  const dP50 = onP50 - offP50;
  const dP50Pct = (dP50 / offP50) * 100;
  const dP99 = onP99 - offP99;
  console.log(
    `${s.padEnd(8)}${offP50.toFixed(4).padStart(12)}${onP50.toFixed(4).padStart(12)}${dP50.toFixed(4).padStart(12)}${`${dP50Pct.toFixed(1)}%`.padStart(9)}${offP99.toFixed(4).padStart(12)}${onP99.toFixed(4).padStart(12)}${dP99.toFixed(4).padStart(12)}`,
  );
  summary.push({
    scenario: s,
    offP50Ms: offP50,
    onP50Ms: onP50,
    deltaP50Ms: dP50,
    deltaP50Pct: dP50Pct,
    offP99Ms: offP99,
    onP99Ms: onP99,
    deltaP99Ms: dP99,
    // Default-ON keeps iff the trail adds <2% at p50 AND <0.05 ms absolute.
    withinBudget: dP50Pct < 2 && dP50 < 0.05,
  });
}

console.log('');
for (const row of summary) console.log(`SUMMARY ${JSON.stringify(row)}`);
