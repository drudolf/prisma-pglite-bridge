/**
 * Snapshot/reset scaling with schema and data size. Uses the same SnapshotManager as
 * the bridge, server, and testing helpers, without ORM or cold-start costs.
 * Each table has an identity, a generated column, and 20 seed rows by default.
 * --rows, --indexes (additional indexes), and --payload-bytes vary the workload.
 * Every reset follows a mutation and its restored data is checked afterwards.
 *
 * pnpm bench:reset                         # 1, 10, 50, 100 tables; 50 resets each
 * pnpm bench:reset -n 100 -w 10 --tables 10,100 --json
 * pnpm bench:reset --operation snapshot -n 20 --tables 1,10,100 --json
 * pnpm exec node --expose-gc --import tsx benchmark/snapshot-reset.ts \
 *   --tables 1 --rows 100000 --indexes 2 --payload-bytes 256 --memory -n 10 --json
 * --memory requires one table-count case per process and reports retained RSS
 * after GC, WAL size, and the process-wide RSS high-water mark (including startup).
 * Snapshot mode times replacement of an existing snapshot; reset and
 * verification run outside the timer. snapshotMs is the first capture.
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
const operation = arg('--operation', 'reset');
const seedRows = Number(arg('--rows', '20'));
const extraIndexes = Number(arg('--indexes', '0'));
const payloadBytes = Number(arg('--payload-bytes', '0'));
const measureMemory = args.includes('--memory');
assert(operation === 'reset' || operation === 'snapshot', 'invalid --operation');
assert(Number.isSafeInteger(iterations) && iterations > 0, '-n must be a positive integer');
assert(Number.isSafeInteger(warmup) && warmup >= 0, '-w must be a nonnegative integer');
assert(
  tableCounts.every((n) => Number.isSafeInteger(n) && n > 0),
  'invalid --tables',
);
// Leave room for the final identity probe and its doubled int value.
assert(
  Number.isSafeInteger(seedRows) && seedRows >= 0 && seedRows <= 1_073_741_822,
  'invalid --rows',
);
assert(Number.isSafeInteger(extraIndexes) && extraIndexes >= 0, 'invalid --indexes');
assert(Number.isSafeInteger(payloadBytes) && payloadBytes >= 0, 'invalid --payload-bytes');
if (measureMemory) {
  assert(
    tableCounts.length === 1,
    '--memory requires a single --tables value; run each case separately',
  );
  assert(typeof globalThis.gc === 'function', '--memory requires node --expose-gc');
}

const payloadColumns =
  payloadBytes > 0
    ? {
        definition: ", payload jsonb NOT NULL DEFAULT '{}'::jsonb",
        names: ', payload',
        values: `, jsonb_build_object('key', n, 'data', left(repeat(md5(n::text), ${Math.ceil(payloadBytes / 32)}), ${payloadBytes}))`,
        aggregates: `, COALESCE(sum(octet_length(payload->>'data')), 0)::text AS payload_bytes,
        count(*) FILTER (WHERE (payload->>'key')::int IS DISTINCT FROM value)::text AS invalid_payload`,
        expected: {
          payload_bytes: String(BigInt(seedRows) * BigInt(payloadBytes)),
          invalid_payload: '0',
        },
      }
    : { definition: '', names: '', values: '', aggregates: '', expected: {} };
const expectedContents = {
  n: String(seedRows),
  total: String(BigInt(seedRows) * BigInt(seedRows + 1)),
  ...payloadColumns.expected,
};
const contentsQuery = (table: number): string => `
  SELECT count(*)::text AS n, COALESCE(sum(doubled), 0)::text AS total
  ${payloadColumns.aggregates}
  FROM bench_${table}`;

const memory = async (db: PGlite) => {
  if (!measureMemory) return undefined;
  // Allow completed calls to release temporary buffers before collecting.
  await new Promise<void>((resolve) => setImmediate(resolve));
  globalThis.gc?.();
  const { rows } = await db.query<{ wal_bytes: string; database_bytes: string }>(
    `SELECT COALESCE((SELECT sum(size) FROM pg_ls_waldir()), 0)::text AS wal_bytes,
            pg_database_size(current_database())::text AS database_bytes`,
  );
  const usage = process.memoryUsage();
  return {
    rssBytes: usage.rss,
    heapUsedBytes: usage.heapUsed,
    arrayBuffersBytes: usage.arrayBuffers,
    // Node/libuv reports maxRSS in KiB, including on macOS.
    // https://nodejs.org/docs/latest-v24.x/api/process.html#processresourceusage
    processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    walBytes: Number(rows[0]?.wal_bytes),
    databaseBytes: Number(rows[0]?.database_bytes),
  };
};

const results = [];
for (const tables of tableCounts) {
  const db = await PGlite.create();
  try {
    const readyMemory = await memory(db);
    await db.exec(
      Array.from(
        { length: tables },
        (_, i) => `
        CREATE TABLE bench_${i} (
          id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          value int NOT NULL,
          doubled int GENERATED ALWAYS AS (value * 2) STORED
          ${payloadColumns.definition}
        );
        ${Array.from(
          { length: extraIndexes },
          (_, index) =>
            `CREATE INDEX bench_${i}_extra_${index} ON bench_${i} ((value % ${997 + index}), value);`,
        ).join('\n')}
        INSERT INTO bench_${i} (value ${payloadColumns.names})
        SELECT n ${payloadColumns.values}
        FROM generate_series(1, ${seedRows}) n;
      `,
      ).join('\n'),
    );
    const seededMemory = await memory(db);
    const manager = new SnapshotManager(db);
    const snapshotStart = performance.now();
    await manager.snapshotDb();
    const snapshotMs = performance.now() - snapshotStart;
    const capturedMemory = await memory(db);
    const cycleMemory = [];
    const samples: number[] = [];
    for (let i = 0; i < warmup + iterations; i++) {
      if (operation === 'reset') await db.exec('INSERT INTO bench_0 (value) VALUES (999)');
      const operationStart = performance.now();
      if (operation === 'snapshot') await manager.snapshotDb();
      else await manager.resetDb();
      const elapsed = performance.now() - operationStart;
      if (i >= warmup) samples.push(elapsed);
      if (operation === 'snapshot') {
        await db.exec('INSERT INTO bench_0 (value) VALUES (999)');
        await manager.resetDb();
      }
      const { rows } = await db.query(contentsQuery(0));
      assert.deepEqual(rows, [expectedContents]);
      if (measureMemory) cycleMemory.push({ iteration: i + 1, ...(await memory(db)) });
    }
    // Validate every table and identity after the run, including stress runs
    // with schemas much larger than the default matrix.
    const contents = await db.exec(
      Array.from({ length: tables }, (_, i) => contentsQuery(i)).join(';\n'),
    );
    assert.equal(contents.length, tables);
    for (const result of contents) assert.deepEqual(result.rows, [expectedContents]);
    const identities = await db.exec(
      Array.from(
        { length: tables },
        (_, i) => `INSERT INTO bench_${i} (value) VALUES (${seedRows + 1}) RETURNING id, doubled`,
      ).join(';\n'),
    );
    assert.equal(identities.length, tables);
    for (const result of identities) {
      assert.deepEqual(result.rows, [{ id: seedRows + 1, doubled: (seedRows + 1) * 2 }]);
    }
    samples.sort((a, b) => a - b);
    const percentile = (p: number): number => samples[Math.ceil(samples.length * p) - 1] ?? 0;
    results.push({
      tables,
      snapshotMs,
      p50Ms: percentile(0.5),
      p95Ms: percentile(0.95),
      ...(measureMemory
        ? {
            memory: {
              ready: readyMemory,
              seeded: seededMemory,
              captured: capturedMemory,
              cycles: cycleMemory,
            },
          }
        : {}),
    });
  } finally {
    await db.close();
  }
}

const report = {
  benchmark: 'snapshot-reset',
  operation,
  machine: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
  },
  iterations,
  warmup,
  seedRowsPerTable: seedRows,
  extraIndexes,
  payloadBytes,
  results,
};
if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Snapshot ${operation} — ${report.machine.cpu}, ${process.version}, n=${iterations}`);
  console.table(results);
}
