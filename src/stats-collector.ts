/**
 * Stats collector for adapter lifecycle and query-level telemetry.
 *
 * Instantiated at level 1 or 2. Level 0 is represented by `collector === null`
 * at call sites — the hot path guards on the null rather than paying for a
 * no-op stub. One collector per {@link createPgliteAdapter} call; threaded
 * through the pool into every {@link PGliteBridge}.
 *
 * Percentiles use nearest-rank (no interpolation). `durationMs` is frozen at
 * the instant `close()` was invoked, via the `closeEntryHrtime` the adapter
 * records as its very first action and passes to {@link freeze}.
 */
import type { PGlite } from '@electric-sql/pglite';

export type StatsLevel = 0 | 1 | 2;

export interface Stats {
  /** Capability marker — which level produced this object */
  statsLevel: 1 | 2;
  durationMs: number;
  wasmInitMs: number;
  schemaSetupMs: number;
  queryCount: number;
  failedQueryCount: number;
  totalQueryMs: number;
  avgQueryMs: number;
  p50QueryMs: number;
  p95QueryMs: number;
  maxQueryMs: number;
  resetDbCalls: number;
  /** Undefined only when the `pg_database_size` query rejected */
  dbSizeBytes?: number;
  /** Level 2: process-wide RSS peak (sampled, lower bound) */
  processPeakRssBytes?: number;
  /** Level 2: sum of session-lock wait durations */
  totalSessionLockWaitMs?: number;
  sessionLockAcquisitionCount?: number;
  avgSessionLockWaitMs?: number;
  maxSessionLockWaitMs?: number;
}

const RSS_SAMPLE_INTERVAL_MS = 500;

const percentile = (sorted: readonly number[], p: number): number => {
  const n = sorted.length;
  if (n === 0) return 0;
  const index = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  return sorted[index] ?? 0;
};

const nsToMs = (ns: bigint): number => Number(ns) / 1_000_000;

export class StatsCollector {
  private readonly level: 1 | 2;
  private readonly createdAtHrtime: bigint;

  private queryDurations: number[] = [];
  private totalQueryMs = 0;
  private queryCount = 0;
  private failedQueryCount = 0;
  private resetDbCalls = 0;

  private wasmInitMs = 0;
  private wasmInitSet = false;
  private schemaSetupMs = 0;
  private schemaSetupSet = false;

  private totalSessionLockWaitMs = 0;
  private maxSessionLockWaitMs = 0;
  private sessionLockAcquisitionCount = 0;

  private peakRssBytes = 0;
  private rssInterval: ReturnType<typeof setInterval> | null = null;

  private frozen = false;
  private cachedDurationMs: number | null = null;
  private cachedDbSizeBytes: number | undefined = undefined;
  private dbSizeFrozen = false;

  constructor(level: 1 | 2) {
    this.level = level;
    this.createdAtHrtime = process.hrtime.bigint();

    if (level === 2) {
      this.sampleRss();
      this.rssInterval = setInterval(() => this.sampleRss(), RSS_SAMPLE_INTERVAL_MS);
      this.rssInterval.unref();
    }
  }

  recordQuery(durationMs: number, succeeded: boolean): void {
    this.queryCount += 1;
    this.totalQueryMs += durationMs;
    this.queryDurations.push(durationMs);
    if (!succeeded) this.failedQueryCount += 1;
  }

  recordLockWait(durationMs: number): void {
    if (this.level !== 2) return;
    this.totalSessionLockWaitMs += durationMs;
    this.sessionLockAcquisitionCount += 1;
    if (durationMs > this.maxSessionLockWaitMs) this.maxSessionLockWaitMs = durationMs;
  }

  incrementResetDb(): void {
    this.resetDbCalls += 1;
  }

  markWasmInit(durationMs: number): void {
    if (this.wasmInitSet) return;
    this.wasmInitSet = true;
    this.wasmInitMs = durationMs;
  }

  markSchemaSetup(durationMs: number): void {
    if (this.schemaSetupSet) return;
    this.schemaSetupSet = true;
    this.schemaSetupMs = durationMs;
  }

  async snapshot(pglite: PGlite): Promise<Stats> {
    const durationMs =
      this.cachedDurationMs ?? nsToMs(process.hrtime.bigint() - this.createdAtHrtime);
    const dbSizeBytes = this.dbSizeFrozen ? this.cachedDbSizeBytes : await this.queryDbSize(pglite);

    const sorted = [...this.queryDurations].sort((a, b) => a - b);
    const avgQueryMs = this.queryCount === 0 ? 0 : this.totalQueryMs / this.queryCount;

    const base: Stats = {
      statsLevel: this.level,
      durationMs,
      wasmInitMs: this.wasmInitMs,
      schemaSetupMs: this.schemaSetupMs,
      queryCount: this.queryCount,
      failedQueryCount: this.failedQueryCount,
      totalQueryMs: this.totalQueryMs,
      avgQueryMs,
      p50QueryMs: percentile(sorted, 50),
      p95QueryMs: percentile(sorted, 95),
      maxQueryMs: percentile(sorted, 100),
      resetDbCalls: this.resetDbCalls,
      dbSizeBytes,
    };

    if (this.level === 2) {
      const count = this.sessionLockAcquisitionCount;
      base.processPeakRssBytes = this.peakRssBytes;
      base.totalSessionLockWaitMs = this.totalSessionLockWaitMs;
      base.sessionLockAcquisitionCount = count;
      base.avgSessionLockWaitMs = count === 0 ? 0 : this.totalSessionLockWaitMs / count;
      base.maxSessionLockWaitMs = this.maxSessionLockWaitMs;
    }

    return base;
  }

  async freeze(pglite: PGlite, closeEntryHrtime: bigint): Promise<void> {
    if (this.frozen) return;
    this.frozen = true;

    this.cachedDurationMs = nsToMs(closeEntryHrtime - this.createdAtHrtime);
    this.cachedDbSizeBytes = await this.queryDbSize(pglite);
    this.dbSizeFrozen = true;

    if (this.level === 2) this.sampleRss();
    this.stop();
  }

  stop(): void {
    if (this.rssInterval !== null) {
      clearInterval(this.rssInterval);
      this.rssInterval = null;
    }
  }

  private sampleRss(): void {
    const rss = process.memoryUsage().rss;
    if (rss > this.peakRssBytes) this.peakRssBytes = rss;
  }

  private async queryDbSize(pglite: PGlite): Promise<number | undefined> {
    try {
      const { rows } = await pglite.query<Record<string, unknown>>(
        'SELECT pg_database_size(current_database()) AS size',
      );
      const row = rows[0];
      if (!row) return undefined;
      const value = Object.values(row)[0];
      if (value === undefined || value === null) return undefined;
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  }
}
