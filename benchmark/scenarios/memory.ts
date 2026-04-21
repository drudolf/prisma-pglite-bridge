/**
 * Memory benchmark — peak and retained RSS/heap/arrayBuffers across a
 * representative query mix, with bridge-level phase attribution.
 *
 * Runs heavy `findMany` + large-JSON workloads and records snapshots
 * before/during/after each query. When the bridge attribution probe is
 * available (it exposes `arm()`/`take()` on the PGlite instance), each
 * query emits a {@link QueryAttribution} with per-span {@link
 * BridgeAttributionSpan}s pinpointing where RSS peaked (before exec /
 * before push / after push / after exec). Requires `--expose-gc` for
 * meaningful numbers.
 */
import { once } from 'node:events';
import pg from 'pg';
import type {
  Attribution,
  BridgeAttributionSpan,
  MemorySnapshot,
  QueryAttribution,
  Scenario,
  ScenarioResult,
  StackAttribution,
} from '../adapters/types.ts';

const gc = () => {
  if (typeof globalThis.gc === 'function') globalThis.gc();
};

const snap = (label: string): MemorySnapshot => {
  gc();
  const m = process.memoryUsage();
  return { label, rss: m.rss, heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers };
};

const peek = (label: string): MemorySnapshot => {
  const m = process.memoryUsage();
  return { label, rss: m.rss, heapUsed: m.heapUsed, arrayBuffers: m.arrayBuffers };
};

const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;

const prefixSnapshots = (snapshots: MemorySnapshot[], run: number): MemorySnapshot[] =>
  snapshots.map((snapshot) => ({ ...snapshot, label: `run${run}:${snapshot.label}` }));

type BridgeAttributionProbeLike = {
  arm: (label: string) => void;
  take: (label: string) => Array<{
    label: string;
    kind: 'message' | 'pipeline';
    messageBytes: number;
    rawBytes: number;
    chunkCount: number;
    firstChunkDelayMs: number | null;
    execDurationMs: number;
    beforeExec: Omit<MemorySnapshot, 'label'>;
    firstChunkBeforePush: Omit<MemorySnapshot, 'label'> | null;
    firstChunkAfterPush: Omit<MemorySnapshot, 'label'> | null;
    peakBeforePushChunkIndex: number | null;
    peakAfterPushChunkIndex: number | null;
    peakBeforePush: Omit<MemorySnapshot, 'label'> | null;
    peakAfterPush: Omit<MemorySnapshot, 'label'> | null;
    afterExec: Omit<MemorySnapshot, 'label'>;
  }>;
};

const labelSnapshot = (label: string, snapshot: Omit<MemorySnapshot, 'label'>): MemorySnapshot => ({
  label,
  rss: snapshot.rss,
  heapUsed: snapshot.heapUsed,
  arrayBuffers: snapshot.arrayBuffers,
});

const waitForBridgeAttribution = async () => {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
};

const settleMemory = async () => {
  gc();
  await waitForBridgeAttribution();
  gc();
};

const resetScenarioRows = async (prisma: typeof import('@prisma/client').PrismaClient) => {
  await prisma.blob.deleteMany();
  await prisma.tenant.deleteMany();
  await settleMemory();
};

const samplePeakWhile = async (label: string, execute: () => Promise<unknown>) => {
  const before = peek(`${label}:before`);
  const peak = { ...before, label: `${label}:peak` };
  let running = true;
  const sampler = (async () => {
    while (running) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const current = process.memoryUsage();
      if (current.rss > peak.rss) peak.rss = current.rss;
      if (current.heapUsed > peak.heapUsed) peak.heapUsed = current.heapUsed;
      if (current.arrayBuffers > peak.arrayBuffers) peak.arrayBuffers = current.arrayBuffers;
    }
  })();

  try {
    await execute();
  } finally {
    running = false;
    await sampler;
  }

  const after = peek(`${label}:after`);
  return { before, peak, after };
};

const runAttributedQuery = async (
  label: string,
  execute: () => Promise<unknown>,
  bridgeAttribution: BridgeAttributionProbeLike | undefined,
): Promise<QueryAttribution | null> => {
  if (!bridgeAttribution) {
    await execute();
    return null;
  }

  bridgeAttribution.arm(label);
  const beforeQuery = snap(`${label}:before-query`);
  await execute();
  await waitForBridgeAttribution();
  return peakAttribution({
    label,
    beforeQuery,
    afterQuery: snap(`${label}:after-query`),
    peak: beforeQuery,
    peakSource: 'after_query',
    bridgeSpans: convertBridgeSpans(label, bridgeAttribution.take(label)),
  });
};

const runStackAttributedQuery = async (
  label: string,
  execute: () => Promise<unknown>,
  stackProbe:
    | {
        run: <T>(label: string, adapter: string, fn: () => Promise<T>) => Promise<T>;
        take: (label: string) => StackAttribution | null;
      }
    | undefined,
  adapterName: string | undefined,
): Promise<StackAttribution | null> => {
  if (!stackProbe || !adapterName) {
    await execute();
    return null;
  }

  await stackProbe.run(label, adapterName, execute);
  return stackProbe.take(label);
};

const peakAttribution = (query: QueryAttribution): QueryAttribution => {
  let peak = query.afterQuery;
  let peakSource: QueryAttribution['peakSource'] = 'after_query';

  for (const span of query.bridgeSpans) {
    if (span.beforeExec.rss >= peak.rss) {
      peak = span.beforeExec;
      peakSource = 'before_exec';
    }
    if (span.peakBeforePush && span.peakBeforePush.rss >= peak.rss) {
      peak = span.peakBeforePush;
      peakSource = 'before_push';
    }
    if (span.peakAfterPush && span.peakAfterPush.rss >= peak.rss) {
      peak = span.peakAfterPush;
      peakSource = 'after_push';
    }
    if (span.afterExec.rss >= peak.rss) {
      peak = span.afterExec;
      peakSource = 'after_exec';
    }
  }

  return { ...query, peak, peakSource };
};

const convertBridgeSpans = (
  label: string,
  spans: ReturnType<BridgeAttributionProbeLike['take']>,
): BridgeAttributionSpan[] =>
  spans.map((span, index) => ({
    label: `${label}:bridge-${index + 1}`,
    kind: span.kind,
    messageBytes: span.messageBytes,
    rawBytes: span.rawBytes,
    chunkCount: span.chunkCount,
    firstChunkDelayMs: span.firstChunkDelayMs,
    execDurationMs: span.execDurationMs,
    beforeExec: labelSnapshot(`${label}:bridge-${index + 1}:before-exec`, span.beforeExec),
    firstChunkBeforePush:
      span.firstChunkBeforePush === null
        ? null
        : labelSnapshot(
            `${label}:bridge-${index + 1}:first-chunk-before-push`,
            span.firstChunkBeforePush,
          ),
    firstChunkAfterPush:
      span.firstChunkAfterPush === null
        ? null
        : labelSnapshot(
            `${label}:bridge-${index + 1}:first-chunk-after-push`,
            span.firstChunkAfterPush,
          ),
    peakBeforePushChunkIndex: span.peakBeforePushChunkIndex,
    peakAfterPushChunkIndex: span.peakAfterPushChunkIndex,
    peakBeforePush:
      span.peakBeforePush === null
        ? null
        : labelSnapshot(`${label}:bridge-${index + 1}:peak-before-push`, span.peakBeforePush),
    peakAfterPush:
      span.peakAfterPush === null
        ? null
        : labelSnapshot(`${label}:bridge-${index + 1}:peak-after-push`, span.peakAfterPush),
    afterExec: labelSnapshot(`${label}:bridge-${index + 1}:after-exec`, span.afterExec),
  }));

const attributionStartRss = (attribution: StackAttribution): number => {
  const firstStage = attribution.stages[0];
  return firstStage ? firstStage.snapshot.rss : attribution.peak.rss;
};

/**
 * Check if a memory metric is growing monotonically across snapshots.
 * Returns the slope (bytes per step) and whether it looks like a leak.
 */
const detectLeak = (
  snapshots: MemorySnapshot[],
  metric: keyof Pick<MemorySnapshot, 'rss' | 'heapUsed' | 'arrayBuffers'>,
): { slope: number; monotonic: boolean } => {
  if (snapshots.length < 3) return { slope: 0, monotonic: false };
  const values = snapshots.map((s) => s[metric]);
  let increases = 0;
  let totalΔ = 0;
  for (let i = 1; i < values.length; i++) {
    const δ = (values[i] ?? 0) - (values[i - 1] ?? 0);
    totalΔ += δ;
    if (δ > 0) increases++;
  }
  const slope = totalΔ / (values.length - 1);
  // Monotonic if >80% of steps are increases
  const monotonic = increases / (values.length - 1) > 0.8;
  return { slope, monotonic };
};

export const memory: Scenario = async (prisma, iterations) => {
  const results: ScenarioResult[] = [];
  const hasGc = typeof globalThis.gc === 'function';
  const stackProbe = (prisma as Record<string, unknown>).__stackProbe as
    | {
        run: <T>(label: string, adapter: string, fn: () => Promise<T>) => Promise<T>;
        take: (label: string) => StackAttribution | null;
      }
    | undefined;
  const stackAdapterName = (prisma as Record<string, unknown>).__stackAdapterName as
    | string
    | undefined;
  const stackAttribution = process.env.STACK_ATTRIBUTION === '1';
  const bridgeAttribution = (prisma as Record<string, unknown>).__bridgeAttribution as
    | BridgeAttributionProbeLike
    | undefined;
  const bridgePool = (prisma as Record<string, unknown>).__pool as
    | {
        query: (config: {
          text: string;
          queryMode?: 'simple' | 'extended';
          rowMode?: 'array';
          types?: { getTypeParser: () => (value: string) => string };
        }) => Promise<unknown>;
        connect: () => Promise<{
          query: (query: unknown) => unknown;
          release: () => void;
        }>;
      }
    | undefined;
  const simpleQueryAttribution = process.env.BRIDGE_ATTRIBUTION_SIMPLE_QUERY === '1';
  const rawPgModeAttribution = process.env.BRIDGE_ATTRIBUTION_RAW_PG === '1';
  const sampledWideReadModes = process.env.WIDE_READ_MODE_SAMPLING === '1';
  const sampledPayloadModes = process.env.PAYLOAD_MODE_SAMPLING === '1';
  const { Query } = pg;
  const rawTextTypes = { getTypeParser: () => (value: string) => value };

  await resetScenarioRows(prisma);

  const runStreamingPgQuery = async (
    text: string,
    types?: { getTypeParser: () => (value: string) => string },
  ): Promise<void> => {
    if (!bridgePool) return;
    const client = await bridgePool.connect();
    try {
      const query = new Query({ text, queryMode: 'simple', rowMode: 'array', types });
      client.query(query);
      query.on('row', () => {});
      await Promise.race([
        once(query, 'end'),
        once(query, 'error').then(([error]) => {
          throw error;
        }),
      ]);
    } finally {
      client.release();
    }
  };

  // ── Leak detection: 1,000 ops, snapshot every 100 ──
  {
    const timings: number[] = [];
    const allSnapshots: MemorySnapshot[] = [];

    for (let run = 0; run < iterations; run++) {
      await resetScenarioRows(prisma);
      const snapshots: MemorySnapshot[] = [snap('0')];
      const start = performance.now();

      for (let batch = 0; batch < 10; batch++) {
        for (let i = 0; i < 100; i++) {
          await prisma.tenant.create({
            data: {
              name: `leak-${run}-${batch}-${i}`,
              slug: `leak-${run}-${batch}-${i}-${Date.now()}`,
            },
          });
        }
        snapshots.push(snap(`${(batch + 1) * 100}`));
      }

      timings.push(performance.now() - start);
      allSnapshots.push(...prefixSnapshots(snapshots, run + 1));

      // Analyze growth curves
      const heapLeak = detectLeak(snapshots, 'heapUsed');
      const abLeak = detectLeak(snapshots, 'arrayBuffers');

      console.log(hasGc ? '' : '      (without --expose-gc, numbers are noisy)');
      console.log(
        `      run ${run + 1}/${iterations} heap slope: ${MB(heapLeak.slope)}/100ops ${
          heapLeak.monotonic ? '⚠ monotonic' : '✓ stable'
        }`,
      );
      console.log(
        `      run ${run + 1}/${iterations} wasm slope: ${MB(abLeak.slope)}/100ops ${
          abLeak.monotonic ? '⚠ monotonic' : '✓ stable'
        }`,
      );

      await resetScenarioRows(prisma);
    }

    results.push({ name: 'leak detect 1k ops', timings, memory: allSnapshots });
  }

  // ── 1MB JSON round-trips — Buffer.concat stress ──
  {
    const bigJson = { payload: 'x'.repeat(1_000_000), nested: { deep: true } };
    const timings: number[] = [];
    const allSnapshots: MemorySnapshot[] = [];
    const attribution: Attribution[] = [];

    for (let run = 0; run < iterations; run++) {
      await resetScenarioRows(prisma);
      const snapshots: MemorySnapshot[] = [snap('0')];
      const start = performance.now();

      for (let i = 0; i < 10; i++) {
        const tenant = await prisma.tenant.create({
          data: {
            name: `json-${run}-${i}`,
            slug: `json-${run}-${i}-${Date.now()}`,
            config: bigJson,
          },
        });
        const label = `run${run + 1}:json-findUnique:${i + 1}`;
        const stackTrace =
          stackAttribution && i === 0
            ? await runStackAttributedQuery(
                label,
                () => prisma.tenant.findUnique({ where: { id: tenant.id } }),
                stackProbe,
                stackAdapterName,
              )
            : await prisma.tenant.findUnique({ where: { id: tenant.id } }).then(() => null);
        if (stackTrace) {
          attribution.push(stackTrace);
        }
      }

      snapshots.push(snap('10×1MB'));
      timings.push(performance.now() - start);
      allSnapshots.push(...prefixSnapshots(snapshots, run + 1));

      const startSnap = snapshots[0];
      const endSnap = snapshots[1];
      if (startSnap && endSnap) {
        console.log(
          `      run ${run + 1}/${iterations} 10×1MB JSON: heap Δ${MB(endSnap.heapUsed - startSnap.heapUsed)}, wasm Δ${MB(endSnap.arrayBuffers - startSnap.arrayBuffers)}`,
        );
      }
      const jsonTrace = attribution[attribution.length - 1];
      if (jsonTrace && 'peakStage' in jsonTrace) {
        console.log(
          `      run ${run + 1}/${iterations} 10×1MB JSON stack attribution: peak ${jsonTrace.peakStage} rss ${MB(jsonTrace.peak.rss - attributionStartRss(jsonTrace))}`,
        );
      }

      if (sampledPayloadModes && bridgePool) {
        const sampledTenant = await prisma.tenant.create({
          data: {
            name: `json-sampled-${run}`,
            slug: `json-sampled-${run}`,
            config: bigJson,
          },
        });
        const tenantId = sampledTenant.id.replace(/'/g, "''");
        const sampledModes = [
          [
            'json:prisma',
            () =>
              prisma.tenant.findUnique({
                where: { id: sampledTenant.id },
                select: { id: true, config: true },
              }),
          ],
          [
            'json:pg-simple-object',
            () =>
              bridgePool.query({
                text: `SELECT "id", "config" FROM "Tenant" WHERE "id" = '${tenantId}'`,
                queryMode: 'simple',
              }),
          ],
          [
            'json:pg-simple-array',
            () =>
              bridgePool.query({
                text: `SELECT "id", "config" FROM "Tenant" WHERE "id" = '${tenantId}'`,
                queryMode: 'simple',
                rowMode: 'array',
              }),
          ],
          [
            'json:pg-streaming-array',
            () =>
              runStreamingPgQuery(`SELECT "id", "config" FROM "Tenant" WHERE "id" = '${tenantId}'`),
          ],
          [
            'json:pg-streaming-raw-text',
            () =>
              runStreamingPgQuery(
                `SELECT "id", "config" FROM "Tenant" WHERE "id" = '${tenantId}'`,
                rawTextTypes,
              ),
          ],
        ] as const;

        for (const [mode, execute] of sampledModes) {
          const sampled = await samplePeakWhile(mode, execute);
          console.log(
            `      run ${run + 1}/${iterations} sampled ${mode}: peak rss Δ${MB(sampled.peak.rss - sampled.before.rss)}, heap Δ${MB(sampled.peak.heapUsed - sampled.before.heapUsed)}, wasm Δ${MB(sampled.peak.arrayBuffers - sampled.before.arrayBuffers)} | after rss Δ${MB(sampled.after.rss - sampled.before.rss)}`,
          );
        }
      }

      await resetScenarioRows(prisma);
    }

    results.push({ name: '10×1MB JSON', timings, memory: allSnapshots, attribution });
  }

  // ── 100KB Bytes (binary) round-trips ──
  {
    const blobData = Buffer.alloc(100_000, 0xab);
    const timings: number[] = [];
    const allSnapshots: MemorySnapshot[] = [];

    for (let run = 0; run < iterations; run++) {
      await resetScenarioRows(prisma);
      const snapshots: MemorySnapshot[] = [snap('0')];
      const start = performance.now();

      for (let i = 0; i < 50; i++) {
        const blob = await prisma.blob.create({
          data: { name: `bin-${run}-${i}`, data: blobData, size: blobData.length },
        });
        await prisma.blob.findUnique({ where: { id: blob.id } });
      }

      snapshots.push(snap('50×100KB'));
      timings.push(performance.now() - start);
      allSnapshots.push(...prefixSnapshots(snapshots, run + 1));

      const startSnap = snapshots[0];
      const endSnap = snapshots[1];
      if (startSnap && endSnap) {
        console.log(
          `      run ${run + 1}/${iterations} 50×100KB Bytes: heap Δ${MB(endSnap.heapUsed - startSnap.heapUsed)}, wasm Δ${MB(endSnap.arrayBuffers - startSnap.arrayBuffers)}`,
        );
      }

      if (sampledPayloadModes && bridgePool) {
        const sampledBlob = await prisma.blob.create({
          data: {
            name: `bin-sampled-${run}`,
            data: blobData,
            size: blobData.length,
          },
        });
        const blobId = sampledBlob.id.replace(/'/g, "''");
        const sampledModes = [
          [
            'bytes:prisma',
            () =>
              prisma.blob.findUnique({
                where: { id: sampledBlob.id },
                select: { id: true, data: true },
              }),
          ],
          [
            'bytes:pg-simple-object',
            () =>
              bridgePool.query({
                text: `SELECT "id", "data" FROM "Blob" WHERE "id" = '${blobId}'`,
                queryMode: 'simple',
              }),
          ],
          [
            'bytes:pg-simple-array',
            () =>
              bridgePool.query({
                text: `SELECT "id", "data" FROM "Blob" WHERE "id" = '${blobId}'`,
                queryMode: 'simple',
                rowMode: 'array',
              }),
          ],
          [
            'bytes:pg-streaming-array',
            () => runStreamingPgQuery(`SELECT "id", "data" FROM "Blob" WHERE "id" = '${blobId}'`),
          ],
          [
            'bytes:pg-streaming-raw-text',
            () =>
              runStreamingPgQuery(
                `SELECT "id", "data" FROM "Blob" WHERE "id" = '${blobId}'`,
                rawTextTypes,
              ),
          ],
        ] as const;

        for (const [mode, execute] of sampledModes) {
          const sampled = await samplePeakWhile(mode, execute);
          console.log(
            `      run ${run + 1}/${iterations} sampled ${mode}: peak rss Δ${MB(sampled.peak.rss - sampled.before.rss)}, heap Δ${MB(sampled.peak.heapUsed - sampled.before.heapUsed)}, wasm Δ${MB(sampled.peak.arrayBuffers - sampled.before.arrayBuffers)} | after rss Δ${MB(sampled.after.rss - sampled.before.rss)}`,
          );
        }
      }

      await resetScenarioRows(prisma);
    }

    results.push({ name: '50×100KB Bytes', timings, memory: allSnapshots });
  }

  // ── Wide JSON findMany reads — payload-heavy arrayBuffers pressure ──
  {
    const rowCount = 24;
    const readCount = 8;
    const wideJson = {
      payload: 'w'.repeat(256_000),
      flags: Array.from({ length: 64 }, (_, i) => `flag-${i}`),
      nested: { depth: 3, ready: true },
    };
    const timings: number[] = [];
    const allSnapshots: MemorySnapshot[] = [];
    const attribution: Attribution[] = [];

    for (let run = 0; run < iterations; run++) {
      await resetScenarioRows(prisma);
      const slugPrefix = `wide-json-${run + 1}`;
      for (let i = 0; i < rowCount; i++) {
        await prisma.tenant.create({
          data: {
            name: `wide-json-${run}-${i}`,
            slug: `${slugPrefix}-${i}`,
            config: { ...wideJson, row: i },
          },
        });
      }

      const snapshots: MemorySnapshot[] = [snap('0')];
      const start = performance.now();

      for (let i = 0; i < readCount; i++) {
        const attributionLabel = `run${run + 1}:wide-json-findMany:${i + 1}`;
        const shouldTrack = bridgeAttribution !== undefined && i === 0;
        const shouldTrackStack = stackAttribution && i === 0;

        const queryAttribution = shouldTrack
          ? await runAttributedQuery(
              attributionLabel,
              () =>
                prisma.tenant.findMany({
                  where: { slug: { startsWith: slugPrefix } },
                  select: { id: true, config: true },
                }),
              bridgeAttribution,
            )
          : await prisma.tenant
              .findMany({
                where: { slug: { startsWith: slugPrefix } },
                select: { id: true, config: true },
              })
              .then(() => null);

        if (queryAttribution) {
          attribution.push(queryAttribution);
        }

        if (shouldTrackStack) {
          const stackTrace = await runStackAttributedQuery(
            `${attributionLabel}:stack`,
            () =>
              prisma.tenant.findMany({
                where: { slug: { startsWith: slugPrefix } },
                select: { id: true, config: true },
              }),
            stackProbe,
            stackAdapterName,
          );
          if (stackTrace) {
            attribution.push(stackTrace);
          }
        }
      }

      snapshots.push(snap(`${readCount}×wide-json-findMany`));
      timings.push(performance.now() - start);
      allSnapshots.push(...prefixSnapshots(snapshots, run + 1));

      const startSnap = snapshots[0];
      const endSnap = snapshots[1];
      if (startSnap && endSnap) {
        console.log(
          `      run ${run + 1}/${iterations} ${readCount}×wide JSON findMany (${rowCount}×256KB rows): heap Δ${MB(endSnap.heapUsed - startSnap.heapUsed)}, wasm Δ${MB(endSnap.arrayBuffers - startSnap.arrayBuffers)}`,
        );
      }

      const runAttribution = attribution[attribution.length - 1];
      if (runAttribution && 'beforeQuery' in runAttribution) {
        console.log(
          `      run ${run + 1}/${iterations} wide JSON attribution: peak ${runAttribution.peakSource} rss ${MB(runAttribution.peak.rss - runAttribution.beforeQuery.rss)}`,
        );
      }
      if (runAttribution && 'peakStage' in runAttribution) {
        console.log(
          `      run ${run + 1}/${iterations} wide JSON stack attribution: peak ${runAttribution.peakStage} rss ${MB(runAttribution.peak.rss - attributionStartRss(runAttribution))}`,
        );
      }

      if ((simpleQueryAttribution || rawPgModeAttribution) && bridgeAttribution && bridgePool) {
        const escapedSlugPrefix = slugPrefix.replace(/'/g, "''");
        const text =
          `SELECT "id", "config" FROM "Tenant" ` +
          `WHERE "slug" LIKE '${escapedSlugPrefix}%' ORDER BY "id"`;

        if (simpleQueryAttribution) {
          const simpleAttribution = await runAttributedQuery(
            `run${run + 1}:wide-json-simple-query`,
            () =>
              bridgePool.query({
                text,
                queryMode: 'simple',
              }),
            bridgeAttribution,
          );
          if (simpleAttribution) {
            attribution.push(simpleAttribution);
            console.log(
              `      run ${run + 1}/${iterations} wide JSON simple-query attribution: peak ${simpleAttribution.peakSource} rss ${MB(simpleAttribution.peak.rss - simpleAttribution.beforeQuery.rss)}`,
            );
          }
        }

        if (rawPgModeAttribution) {
          const arrayAttribution = await runAttributedQuery(
            `run${run + 1}:wide-json-pg-array-query`,
            () =>
              bridgePool.query({
                text,
                queryMode: 'simple',
                rowMode: 'array',
              }),
            bridgeAttribution,
          );
          if (arrayAttribution) {
            attribution.push(arrayAttribution);
            console.log(
              `      run ${run + 1}/${iterations} wide JSON pg-array attribution: peak ${arrayAttribution.peakSource} rss ${MB(arrayAttribution.peak.rss - arrayAttribution.beforeQuery.rss)}`,
            );
          }

          const streamingAttribution = await runAttributedQuery(
            `run${run + 1}:wide-json-pg-streaming-query`,
            () => runStreamingPgQuery(text),
            bridgeAttribution,
          );
          if (streamingAttribution) {
            attribution.push(streamingAttribution);
            console.log(
              `      run ${run + 1}/${iterations} wide JSON pg-streaming attribution: peak ${streamingAttribution.peakSource} rss ${MB(streamingAttribution.peak.rss - streamingAttribution.beforeQuery.rss)}`,
            );
          }

          const rawTextAttribution = await runAttributedQuery(
            `run${run + 1}:wide-json-pg-streaming-raw-text`,
            () => runStreamingPgQuery(text, rawTextTypes),
            bridgeAttribution,
          );
          if (rawTextAttribution) {
            attribution.push(rawTextAttribution);
            console.log(
              `      run ${run + 1}/${iterations} wide JSON pg-streaming raw-text attribution: peak ${rawTextAttribution.peakSource} rss ${MB(rawTextAttribution.peak.rss - rawTextAttribution.beforeQuery.rss)}`,
            );
          }
        }
      }

      if (sampledWideReadModes && bridgePool) {
        const escapedSlugPrefix = slugPrefix.replace(/'/g, "''");
        const text =
          `SELECT "id", "config" FROM "Tenant" ` +
          `WHERE "slug" LIKE '${escapedSlugPrefix}%' ORDER BY "id"`;
        const sampledModes = [
          [
            'prisma',
            () =>
              prisma.tenant.findMany({
                where: { slug: { startsWith: slugPrefix } },
                select: { id: true, config: true },
              }),
          ],
          [
            'pg-simple-object',
            () =>
              bridgePool.query({
                text,
                queryMode: 'simple',
              }),
          ],
          [
            'pg-simple-array',
            () =>
              bridgePool.query({
                text,
                queryMode: 'simple',
                rowMode: 'array',
              }),
          ],
          ['pg-streaming-array', () => runStreamingPgQuery(text)],
          ['pg-streaming-raw-text', () => runStreamingPgQuery(text, rawTextTypes)],
        ] as const;

        for (const [mode, execute] of sampledModes) {
          const sampled = await samplePeakWhile(`wide-json:${mode}`, execute);
          console.log(
            `      run ${run + 1}/${iterations} wide JSON sampled ${mode}: peak rss Δ${MB(sampled.peak.rss - sampled.before.rss)}, heap Δ${MB(sampled.peak.heapUsed - sampled.before.heapUsed)}, wasm Δ${MB(sampled.peak.arrayBuffers - sampled.before.arrayBuffers)} | after rss Δ${MB(sampled.after.rss - sampled.before.rss)}`,
          );
        }
      }

      await resetScenarioRows(prisma);
    }

    results.push({
      name: '8×wide JSON findMany',
      timings,
      memory: allSnapshots,
      attribution,
    });
  }

  return results;
};
