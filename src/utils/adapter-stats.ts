/**
 * Private per-adapter stats state used to power `stats()`.
 *
 * Instantiated at level `'basic'` or `'full'` (level `'off'` means no stats
 * object exists).
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
 * - `'off'` — `stats()` returns `undefined`. Zero hot-path overhead.
 * - `'basic'` — timing (`durationMs`, `schemaSetupMs`), query
 *   percentiles, counters, and `dbSizeBytes`.
 * - `'full'` — `'basic'` plus `processRssPeakBytes` and session-lock
 *   waits.
 */
export type StatsLevel = 'off' | 'basic' | 'full';

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

export interface StatsBasic extends StatsBase {
  statsLevel: 'basic';
}

export interface StatsFull extends StatsBase {
  statsLevel: 'full';
  /**
   * Process-wide RSS high-water mark since process start, read from
   * `process.resourceUsage().maxRSS` (kernel-tracked, lossless). Reflects
   * the entire Node process — parallel test runners, other adapters, and
   * prior work in the same process all contribute. Use only as an
   * ordering signal, not an absolute measurement.
   *
   * `undefined` on runtimes that don't expose `process.resourceUsage`
   * (e.g. Bun, Deno, edge workers) — matches the field-level-undefined
   * contract of every other `Stats` member.
   */
  processRssPeakBytes: number | undefined;
  totalSessionLockWaitMs: number;
  sessionLockAcquisitionCount: number;
  avgSessionLockWaitMs: number;
  maxSessionLockWaitMs: number;
}

export type Stats = StatsBasic | StatsFull;

const DB_SIZE_QUERY_TIMEOUT_MS = 5_000;

/**
 * `process.resourceUsage().maxRSS` returns kilobytes on every platform
 * Node supports — we convert to bytes so the public `processRssPeakBytes`
 * field matches its name. Returns `undefined` on runtimes that don't
 * expose `resourceUsage` (Bun, Deno, edge workers).
 */
const readProcessRssPeakBytes = (): number | undefined => {
  try {
    return process.resourceUsage().maxRSS * 1024;
  } catch {
    return undefined;
  }
};

const percentile = (sorted: readonly number[], p: number): number => {
  const n = sorted.length;
  if (n === 0) return 0;
  const index = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
  /* c8 ignore next */
  return sorted[index] ?? 0;
};

export class AdapterStats implements TelemetrySink {
  private readonly level: 'basic' | 'full';
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

  private frozen = false;
  private cachedDurationMs?: number;
  private cachedDbSizeBytes?: number;
  private dbSizeFrozen = false;

  constructor(level: 'basic' | 'full') {
    this.level = level;
    this.createdAtHrtime = process.hrtime.bigint();
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
    if (this.level !== 'full') return;
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

    if (this.level === 'basic') {
      return { ...base, statsLevel: 'basic' };
    }

    const count = this.sessionLockAcquisitionCount;
    return {
      ...base,
      statsLevel: 'full',
      processRssPeakBytes: readProcessRssPeakBytes(),
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
    }
  }

  private async queryDbSize(pglite: DbSizeQueryable): Promise<number | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('pg_database_size query timed out')),
          DB_SIZE_QUERY_TIMEOUT_MS,
        );
        timer.unref?.();
      });
      const { rows } = await Promise.race([
        pglite.query<{ size: string | null }>(
          'SELECT pg_database_size(current_database())::text AS size',
        ),
        timeout,
      ]);
      const size = rows[0]?.size;
      if (size == null) return undefined;
      const n = Number(size);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
