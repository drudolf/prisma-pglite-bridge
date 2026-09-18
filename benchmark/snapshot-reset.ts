/**
 * Snapshot/reset scaling with schema size. Uses the same SnapshotManager as
 * the bridge, server, and testing helpers, without ORM or cold-start costs.
 * Each table has an identity, a generated column, an index, and 20 seed rows.
 * Every reset follows a mutation and its restored data is checked afterwards.
 *
 * pnpm bench:reset                         # 1, 10, 50, 100 tables; 50 resets each
 * pnpm bench:reset -n 100 -w 10 --tables 10,100 --json
 */
import assert from 'node:assert/strict';
import { cpus } from 'node:os';
import { PGlite } from '@electric-sql/pglite';
import { SnapshotManager } from '../src/pglite-bridge/snapshot-manager.ts';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index < 0 ? fallback : (args[index + 1] ?? fallback);
};
const iterations = Number(arg('-n', '50'));
const warmup = Number(arg('-w', '5'));
const tableCounts = arg('--tables', '1,10,50,100').split(',').map(Number);
assert(Number.isSafeInteger(iterations) && iterations > 0, '-n must be a positive integer');
assert(Number.isSafeInteger(warmup) && warmup >= 0, '-w must be a nonnegative integer');
assert(
  tableCounts.every((n) => Number.isSafeInteger(n) && n > 0),
  'invalid --tables',
);

const results = [];
for (const tables of tableCounts) {
  const db = await PGlite.create();
  try {
    await db.exec(
      Array.from(
        { length: tables },
        (_, i) => `
        CREATE TABLE bench_${i} (
          id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          value int NOT NULL,
          doubled int GENERATED ALWAYS AS (value * 2) STORED
        );
        INSERT INTO bench_${i} (value) SELECT generate_series(1, 20);
      `,
      ).join('\n'),
    );
    const manager = new SnapshotManager(db);
    const snapshotStart = performance.now();
    await manager.snapshotDb();
    const snapshotMs = performance.now() - snapshotStart;
    const samples: number[] = [];
    for (let i = 0; i < warmup + iterations; i++) {
      await db.exec('INSERT INTO bench_0 (value) VALUES (999)');
      const resetStart = performance.now();
      await manager.resetDb();
      const elapsed = performance.now() - resetStart;
      if (i >= warmup) samples.push(elapsed);
      const { rows } = await db.query(
        'SELECT count(*)::int AS n, sum(doubled)::int AS total FROM bench_0',
      );
      assert.deepEqual(rows, [{ n: 20, total: 420 }]);
    }
    // Validate every table and identity after the run, including stress runs
    // with schemas much larger than the default matrix.
    const contents = await db.exec(
      Array.from(
        { length: tables },
        (_, i) => `SELECT count(*)::int AS n, sum(doubled)::int AS total FROM bench_${i}`,
      ).join(';\n'),
    );
    assert.equal(contents.length, tables);
    for (const result of contents) assert.deepEqual(result.rows, [{ n: 20, total: 420 }]);
    const identities = await db.exec(
      Array.from(
        { length: tables },
        (_, i) => `INSERT INTO bench_${i} (value) VALUES (21) RETURNING id, doubled`,
      ).join(';\n'),
    );
    assert.equal(identities.length, tables);
    for (const result of identities) assert.deepEqual(result.rows, [{ id: 21, doubled: 42 }]);
    samples.sort((a, b) => a - b);
    const percentile = (p: number): number => samples[Math.ceil(samples.length * p) - 1] ?? 0;
    results.push({ tables, snapshotMs, p50Ms: percentile(0.5), p95Ms: percentile(0.95) });
  } finally {
    await db.close();
  }
}

const report = {
  benchmark: 'snapshot-reset',
  machine: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
  },
  iterations,
  warmup,
  seedRowsPerTable: 20,
  results,
};
if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Snapshot reset — ${report.machine.cpu}, ${process.version}, n=${iterations}`);
  console.table(results);
}
