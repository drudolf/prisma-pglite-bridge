/**
 * Private per-adapter stats state used to power `stats()`.
 *
 * Instantiated at level 1 or 2 (level 0 means no stats object exists).
 * Query-level timing is recorded directly by the bridge; one-shot lifecycle
 * signals (`markSchemaSetup`, `incrementResetDb`, `freeze`) remain direct
 * method calls invoked by the adapter itself.
 *
 * Percentiles use nearest-rank (no interpolation) over a sliding window of
 * the most recent {@link QUERY_DURATION_WINDOW_SIZE} queries. Lifetime
 * counters (`queryCount`, `totalQueryMs`, `avgQueryMs`) are not windowed.
 * `durationMs` is frozen at the instant `close()` was invoked, via the
 * `closeEntryHrtime` the adapter records as its very first action and
 * passes to {@link freeze}.
 */
import type { PGlite } from '@electric-sql/pglite';
import { nsToMs } from './time.ts';

type DbSizeQueryable = Pick<PGlite, 'query'>;

/**
 * Stats collection level.
 *
 * - `0` — off. `stats()` returns `undefined`. Zero hot-path overhead.
 * - `1` — timing (`durationMs`, `schemaSetupMs`), query percentiles,
 *   counters, and `dbSizeBytes`.
 * - `2` — level 1 plus `processRssPeakBytes` and session-lock waits.
 */
export type StatsLevel = 0 | 1 | 2;

/** Internal bridge-facing telemetry contract. */
export interface TelemetrySink {
  recordQuery(durationMs: number, succeeded: boolean): void;
  recordLockWait(durationMs: number): void;
}

/**
 * Maximum number of recent query durations retained for percentile
 * computation. Beyond this window, `recentP50QueryMs`, `recentP95QueryMs`,
 * and `recentMaxQueryMs` reflect only the most recent N queries — lifetime
 * counters (`queryCount`, `totalQueryMs`, `avgQueryMs`) remain complete.
 */
export const QUERY_DURATION_WINDOW_SIZE = 10_000;

const QUERY_DURATION_TRIM_THRESHOLD = QUERY_DURATION_WINDOW_SIZE * 2;

interface StatsBase {
  durationMs: number;
  schemaSetupMs: number;
  /** Lifetime count of recorded queries. Not windowed. */
  queryCount: number;
  failedQueryCount: number;
  /** Lifetime sum of query durations. Not windowed. */
  totalQueryMs: number;
  /** Lifetime mean query duration. Not windowed. */
  avgQueryMs: number;
  /**
   * Nearest-rank 50th percentile over the most recent
   * {@link QUERY_DURATION_WINDOW_SIZE} queries. Compare to `avgQueryMs`
   * with care: the two fields describe different populations on long-lived
   * adapters.
   */
  recentP50QueryMs: number;
  /** Nearest-rank 95th percentile over the recent-query window. */
  recentP95QueryMs: number;
  /** Maximum query duration within the recent-query window. */
  recentMaxQueryMs: number;
  resetDbCalls: number;
  /** Undefined only when the `pg_database_size` query rejected. */
  dbSizeBytes?: number;
}

export interface Stats1 extends StatsBase {
  statsLevel: 1;
}

export interface Stats2 extends StatsBase {
  statsLevel: 2;
  /**
   * Process-wide RSS peak (sampled, lower bound). This value reflects the
   * entire Node process, not just this adapter — parallel test runners or
   * other work in the same process will inflate it. Use only as an
   * ordering signal, not an absolute measurement.
   */
  processRssPeakBytes: number;
  totalSessionLockWaitMs: number;
  sessionLockAcquisitionCount: number;
  avgSessionLockWaitMs: number;
  maxSessionLockWaitMs: number;
}

export type Stats = Stats1 | Stats2;

const RSS_SAMPLE_INTERVAL_MS = 500;

const percentile = (sorted: readonly number[], p: number): number => {
  const n = sorted.length;
  if (n === 0) return 0;
  const index = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  /* c8 ignore next */
  return sorted[index] ?? 0;
};

export class AdapterStats implements TelemetrySink {
  private readonly level: 1 | 2;
  private readonly createdAtHrtime: bigint;

  private queryDurations: number[] = [];
  private totalQueryMs = 0;
  private queryCount = 0;
  private failedQueryCount = 0;
  private resetDbCalls = 0;

  private schemaSetupMs = 0;
  private schemaSetupSet = false;

  private totalSessionLockWaitMs = 0;
  private maxSessionLockWaitMs = 0;
  private sessionLockAcquisitionCount = 0;

  private peakRssBytes = 0;
  private rssInterval?: ReturnType<typeof setInterval>;

  private frozen = false;
  private cachedDurationMs?: number;
  private cachedDbSizeBytes?: number;
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
    if (this.frozen) return;
    this.queryCount += 1;
    this.totalQueryMs += durationMs;
    this.queryDurations.push(durationMs);
    if (this.queryDurations.length > QUERY_DURATION_TRIM_THRESHOLD) {
      this.queryDurations = this.queryDurations.slice(-QUERY_DURATION_WINDOW_SIZE);
    }
    if (!succeeded) this.failedQueryCount += 1;
  }

  recordLockWait(durationMs: number): void {
    if (this.frozen) return;
    if (this.level !== 2) return;
    this.totalSessionLockWaitMs += durationMs;
    this.sessionLockAcquisitionCount += 1;
    if (durationMs > this.maxSessionLockWaitMs) this.maxSessionLockWaitMs = durationMs;
  }

  incrementResetDb(): void {
    if (this.frozen) return;
    this.resetDbCalls += 1;
  }

  markSchemaSetup(durationMs: number): void {
    if (this.schemaSetupSet) return;
    this.schemaSetupSet = true;
    this.schemaSetupMs = durationMs;
  }

  async snapshot(pglite: DbSizeQueryable): Promise<Stats> {
    const durationMs =
      this.cachedDurationMs ?? nsToMs(process.hrtime.bigint() - this.createdAtHrtime);
    const dbSizeBytes = this.dbSizeFrozen ? this.cachedDbSizeBytes : await this.queryDbSize(pglite);

    const sorted = [...this.queryDurations].sort((a, b) => a - b);
    const avgQueryMs = this.queryCount === 0 ? 0 : this.totalQueryMs / this.queryCount;

    const base: StatsBase = {
      durationMs,
      schemaSetupMs: this.schemaSetupMs,
      queryCount: this.queryCount,
      failedQueryCount: this.failedQueryCount,
      totalQueryMs: this.totalQueryMs,
      avgQueryMs,
      recentP50QueryMs: percentile(sorted, 50),
      recentP95QueryMs: percentile(sorted, 95),
      recentMaxQueryMs: percentile(sorted, 100),
      resetDbCalls: this.resetDbCalls,
      dbSizeBytes,
    };

    if (this.level === 1) {
      return { ...base, statsLevel: 1 };
    }

    const count = this.sessionLockAcquisitionCount;
    return {
      ...base,
      statsLevel: 2,
      processRssPeakBytes: this.peakRssBytes,
      totalSessionLockWaitMs: this.totalSessionLockWaitMs,
      sessionLockAcquisitionCount: count,
      avgSessionLockWaitMs: count === 0 ? 0 : this.totalSessionLockWaitMs / count,
      maxSessionLockWaitMs: this.maxSessionLockWaitMs,
    };
  }

  async freeze(pglite: DbSizeQueryable, closeEntryHrtime: bigint): Promise<void> {
    if (this.frozen) return;
    this.frozen = true;

    this.cachedDurationMs = nsToMs(closeEntryHrtime - this.createdAtHrtime);
    try {
      this.cachedDbSizeBytes = await this.queryDbSize(pglite);
    } finally {
      this.dbSizeFrozen = true;
      if (this.level === 2) this.sampleRss();
      this.stop();
    }
  }

  stop(): void {
    if (this.rssInterval !== undefined) {
      clearInterval(this.rssInterval);
      this.rssInterval = undefined;
    }
  }

  private sampleRss(): void {
    const rss = process.memoryUsage().rss;
    if (rss > this.peakRssBytes) this.peakRssBytes = rss;
  }

  private async queryDbSize(pglite: DbSizeQueryable): Promise<number | undefined> {
    try {
      const { rows } = await pglite.query<{ size: string | null }>(
        'SELECT pg_database_size(current_database())::text AS size',
      );
      const size = rows[0]?.size;
      if (size == null) return undefined;
      const n = Number(size);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  }
}
