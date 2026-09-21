/**
 * SQL classification and query-trail scaling, with an optional source-level
 * A/B against another checkout. Alternates order each round; correctness
 * checks and trail prefill are outside timing. Run with pnpm bench:sql.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { PGlite } from '@electric-sql/pglite';
import type { CopyInVerdict } from '../src/duplex/copy-in.ts';
import type { PgBridgePool } from '../src/pool/index.ts';
import type { QueryTrailRecorder } from '../src/pool/query-trail.ts';

const { values } = parseArgs({
  options: { baseline: { type: 'string' }, rounds: { type: 'string', default: '5' } },
});
const rounds = Number(values.rounds);
assert(Number.isInteger(rounds) && rounds > 0, '--rounds must be a positive integer');

interface Variant {
  label: string;
  source: { root: string; sha256: Record<string, string> };
  sniffCopyIn: (sql: string) => CopyInVerdict;
  QueryTrailRecorder: typeof QueryTrailRecorder;
  PgBridgePool: typeof PgBridgePool;
}

const load = async (label: string, root: string): Promise<Variant> => {
  const moduleAt = (path: string) => import(pathToFileURL(resolve(root, path)).href);
  const [copy, trail, pool] = await Promise.all([
    moduleAt('src/duplex/copy-in.ts'),
    moduleAt('src/pool/query-trail.ts'),
    moduleAt('src/pool/index.ts'),
  ]);
  const sha256 = Object.fromEntries(
    ['src/duplex/copy-in.ts', 'src/pool/query-trail.ts'].map((path) => [
      path,
      createHash('sha256')
        .update(readFileSync(resolve(root, path)))
        .digest('hex'),
    ]),
  );
  return { label, source: { root: resolve(root), sha256 }, ...copy, ...trail, ...pool };
};
const variants: Variant[] = [];
if (values.baseline) variants.push(await load('baseline', values.baseline));
variants.push(await load('current', resolve(import.meta.dirname, '..')));

const results: { scenario: string; variant: string; p50Ms: number; samplesMs: number[] }[] = [];
const record = (scenario: string, samples: number[][]): void => {
  variants.forEach((variant, index) => {
    const times = samples[index] ?? [];
    const sorted = [...times].sort((a, b) => a - b);
    results.push({
      scenario,
      variant: variant.label,
      p50Ms: sorted[Math.floor(sorted.length / 2)] ?? Number.NaN,
      samplesMs: times,
    });
  });
};
const order = (round: number): number[] => {
  const indices = variants.map((_, i) => i);
  return round % 2 === 0 ? indices : indices.reverse();
};

const sqlCases: [string, string, CopyInVerdict, number][] = [
  ['select', 'SELECT 1 AS value', 'not-copy-in', 30_000],
  ['numeric-list-64KiB', `SELECT ${'12345,'.repeat(10_922)}1`, 'not-copy-in', 100],
  ['literal-256KiB', `SELECT '${'x'.repeat(256 * 1024)}'`, 'not-copy-in', 100],
  ['comment-1MiB', `/* ${'x'.repeat(1024 * 1024)} */ SELECT 1`, 'not-copy-in', 100],
  ['copy', 'COPY t FROM STDIN WITH (FORMAT csv)', 'capture', 30_000],
  ['hidden-copy', "SELECT 'COPY t FROM STDIN'", 'not-copy-in', 30_000],
  ['copy-identifier', `SELECT ${'12345,'.repeat(10_922)}1 AS copy_count`, 'not-copy-in', 100],
  ['late-copy', `SELECT '${'x'.repeat(256 * 1024)}'; COPY t FROM STDIN`, 'reject-multi', 100],
];
for (const [name, sql, expected, iterations] of sqlCases) {
  const samples = variants.map(() => [] as number[]);
  for (const variant of variants) assert.equal(variant.sniffCopyIn(sql), expected);
  for (let round = -1; round < rounds; round++) {
    for (const index of order(round)) {
      const variant = variants[index] as Variant;
      let verdict: CopyInVerdict = 'not-copy-in';
      const start = performance.now();
      for (let i = 0; i < iterations; i++) verdict = variant.sniffCopyIn(sql);
      if (round >= 0) samples[index]?.push((performance.now() - start) / iterations);
      assert.equal(verdict, expected);
    }
  }
  record(`scanner/${name}`, samples);
}

for (const capacity of [500, 50_000, 100_000]) {
  for (const largeSql of [false, true]) {
    const iterations = largeSql ? 100 : 10_000;
    const sql = largeSql ? `SELECT '${'x'.repeat(1024 * 1024)}'` : 'SELECT $1';
    const recorders = variants.map(({ QueryTrailRecorder: Recorder }) => {
      const recorder = new Recorder({ maxEntries: capacity });
      for (let i = 0; i <= capacity; i++) recorder.begin(0, 'SELECT 1').settle({ rowCount: 1 });
      return recorder;
    });
    const samples = variants.map(() => [] as number[]);
    for (let round = -1; round < rounds; round++) {
      for (const index of order(round)) {
        const recorder = recorders[index] as QueryTrailRecorder;
        const start = performance.now();
        for (let i = 0; i < iterations; i++) recorder.begin(0, sql, [42]).settle({ rowCount: 1 });
        if (round >= 0) samples[index]?.push((performance.now() - start) / iterations);
      }
    }
    for (const recorder of recorders) {
      const entries = recorder.entries();
      assert.equal(entries.length, capacity);
      assert.equal(entries.at(-1)?.seq, capacity + (rounds + 1) * iterations);
      for (let i = 1; i < entries.length; i++) {
        assert.equal(entries[i]?.seq, (entries[i - 1]?.seq ?? -1) + 1);
      }
    }
    record(`trail/${capacity}/${largeSql ? '1MiB' : 'short'}`, samples);
  }
}

// Sharing one backend keeps database state and WASM warmup identical. Queries
// alternate between pools sequentially, with no transactions or cached plans.
const pglite = await PGlite.create();
const pools = variants.map(
  ({ PgBridgePool: Pool }) => new Pool({ pglite, statementCaching: false, queryTrail: true }),
);
try {
  const poolCases: [string, string, number, number][] = [
    ['select', 'SELECT 1 AS value', 1, 1000],
    ['literal-256KiB', `SELECT length('${'x'.repeat(256 * 1024)}') AS value`, 256 * 1024, 100],
    [
      'literal-4MiB',
      `SELECT length('${'x'.repeat(4 * 1024 * 1024)}') AS value`,
      4 * 1024 * 1024,
      20,
    ],
    ['numeric-list-64KiB', `SELECT 1 IN (${'12345,'.repeat(10_922)}1) AS value`, 1, 100],
  ];
  for (const [name, sql, expected, iterations] of poolCases) {
    const samples = variants.map(() => [] as number[]);
    for (const pool of pools) {
      const result = await pool.query(sql);
      assert.equal(Number(result.rows[0].value), expected);
      for (let i = 0; i < 30; i++) await pool.query(sql);
      pool.clearQueryTrail();
    }
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < iterations; i++) {
        for (const index of order(round + i)) {
          const start = performance.now();
          await (pools[index] as PgBridgePool).query(sql);
          samples[index]?.push(performance.now() - start);
        }
      }
    }
    record(`pool/${name}`, samples);
  }
} finally {
  for (const pool of pools) await pool.end();
  await pglite.close();
}

console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      sources: variants.map(({ label, source }) => ({ label, ...source })),
      rounds,
      results,
    },
    null,
    2,
  ),
);
