/**
 * On-failure query trail — capture layer (design:
 * .claude/plans/query-trail-design.md, tribunal-reviewed).
 *
 * A pool-owned ring buffer of the queries the APP issued, captured at the
 * SQL boundary (`PgBridgeClient.query()` override) where text and params
 * are cleartext — never decoded from wire bytes. Bridge-internal recovery
 * statements (duplex teardown ROLLBACKs) are issued below this layer and
 * must never appear in the trail.
 *
 * Capture must never fail a user's query: `begin` cannot throw. An
 * internal capture error appends a sentinel entry, stops further capture
 * for the run, and warns once on stderr; the formatter header reports
 * "trail disabled after entry N".
 */

/** Default ring capacity (entries). */
const DEFAULT_TRAIL_MAX_ENTRIES = 500;
/** Default per-param preview cap (characters). */
export const DEFAULT_TRAIL_MAX_PARAM_CHARS = 200;
/** SQL text cap (characters); the cap being hit is noted in the preview. */
export const TRAIL_SQL_MAX_CHARS = 2000;
/** Error-message cap (characters). */
const ERROR_MESSAGE_MAX_CHARS = 500;
/** Suffix appended when SQL is capped; counted inside {@link TRAIL_SQL_MAX_CHARS}. */
const SQL_CAP_MARKER = ' … [capped]';
/** The sentinel entry's SQL, appended once when an internal capture error
 *  disables further capture for the run. */
const DISABLED_SENTINEL_SQL = '<trail capture disabled>';

export interface QueryTrailOptions {
  /** Ring capacity; overflow drops the OLDEST entries, counted in
   *  {@link QueryTrailMeta.droppedCount}, with a one-time stderr warning
   *  on first overflow. Default {@link DEFAULT_TRAIL_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Per-param preview cap in characters. Default
   *  {@link DEFAULT_TRAIL_MAX_PARAM_CHARS}. */
  maxParamChars?: number;
  /** Render every param as `<redacted>` — for CI environments where logs
   *  are durable and shared. Default `false`. */
  redactParams?: boolean;
}

/** Statement classification derived from the statement head (lowercase and
 *  leading-comment forms included). DDL is `'query'` — its implicit commit
 *  gets no marker. */
export type QueryTrailKind =
  | 'query'
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'rollback-to'
  | 'savepoint'
  | 'release';

export interface QueryTrailError {
  code?: string;
  message: string;
}

export interface QueryTrailEntry {
  /** Per-trail-relative submission order across all pool clients; resets
   *  to 0 on {@link QueryTrailRecorder.clear}. */
  seq: number;
  /** Milliseconds since trail start/clear. */
  atMs: number;
  /** Stable per-client ordinal within the pool. */
  clientId: number;
  /** Capped at {@link TRAIL_SQL_MAX_CHARS}; opaque submittables record a
   *  `<submittable:ClassName>` tag instead of being dropped. */
  sql: string;
  /** Capture-time previews, never live references: rendered + truncated,
   *  binary as `<bytes:N>` (N = byte count), null/undefined tagged. */
  params: readonly string[];
  kind: QueryTrailKind;
  /** A failure hook can fire while a query is in flight; pending entries
   *  render as such instead of looking half-recorded. */
  status: 'pending' | 'settled';
  durationMs?: number;
  rowCount?: number | null;
  error?: QueryTrailError;
}

export interface QueryTrailMeta {
  /** Entries dropped by ring overflow since last clear. */
  droppedCount: number;
  /** Set when an internal capture error disabled further capture; the
   *  sentinel entry carries this seq. */
  disabledAfterSeq?: number;
}

/** Returned by {@link QueryTrailRecorder.begin}; settle is idempotent —
 *  the first call wins. */
export interface QueryTrailHandle {
  settle(outcome: { rowCount?: number | null; error?: unknown }): void;
}

/** The no-op handle returned once capture is disabled — a user query the
 *  client still settles resolves into nothing. */
const INERT_HANDLE: QueryTrailHandle = {
  /* v8 ignore next — settled only when the client resolves a query captured AFTER a mid-run disable; the disable path is unit-tested at begin(), a wired disable-then-settle is not */
  settle: () => {},
};

/** Render one param value to a bounded capture-time preview: never a live
 *  reference, never longer than `maxParamChars`. Binary is byte-counted,
 *  null/undefined tagged, Dates ISO'd, everything else stringified. May throw
 *  if a value's `toString`/getter is hostile — the caller treats that as the
 *  capture-error trigger. */
const previewParam = (value: unknown, maxParamChars: number): string => {
  if (value === null) return '<null>';
  if (value === undefined) return '<undefined>';
  if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
  if (value instanceof Date) return value.toISOString();
  const rendered = typeof value === 'string' ? value : String(value);
  return rendered.length > maxParamChars ? rendered.slice(0, maxParamChars) : rendered;
};

/** Cap SQL to {@link TRAIL_SQL_MAX_CHARS} total, appending {@link
 *  SQL_CAP_MARKER} as the trailing suffix so `sql.length` never exceeds the
 *  cap and the marker is always last. */
const capSql = (sql: string): string =>
  sql.length <= TRAIL_SQL_MAX_CHARS
    ? sql
    : sql.slice(0, TRAIL_SQL_MAX_CHARS - SQL_CAP_MARKER.length) + SQL_CAP_MARKER;

/** Matches any run of leading whitespace, line comments (`-- …` to end of
 *  line or string) and block comments (`/* … *&#47;`, or to end of string when
 *  unterminated) — so {@link deriveKind} reads the first real statement
 *  keyword. Branch-free: a single anchored strip replaces the loop. */
const LEADING_NOISE = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?(?:\*\/|$))+/;

/** Strip leading whitespace and comments so the classifier reads the first
 *  real statement keyword. */
const stripLeadingNoise = (sql: string): string => sql.replace(LEADING_NOISE, '');

/** Derive the {@link QueryTrailKind} from the statement head (lowercase,
 *  leading whitespace, and leading comments tolerated). The full savepoint
 *  vocabulary is distinct: ROLLBACK TO and RELEASE are their own kinds, not
 *  mis-bucketed rollbacks/queries. DDL is `'query'`. */
const deriveKind = (sql: string): QueryTrailKind => {
  const head = stripLeadingNoise(sql).toUpperCase();
  if (head.startsWith('BEGIN') || head.startsWith('START TRANSACTION')) return 'begin';
  if (head.startsWith('COMMIT') || head.startsWith('END')) return 'commit';
  if (head.startsWith('ROLLBACK TO')) return 'rollback-to';
  if (head.startsWith('ROLLBACK')) return 'rollback';
  if (head.startsWith('SAVEPOINT')) return 'savepoint';
  if (head.startsWith('RELEASE')) return 'release';
  return 'query';
};

/** Render a settle outcome's error into the bounded trail shape: message
 *  capped to {@link ERROR_MESSAGE_MAX_CHARS}; `code` only when the thrown
 *  value carries a string `code`. */
const previewError = (error: unknown): QueryTrailError => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message =
    rawMessage.length > ERROR_MESSAGE_MAX_CHARS
      ? rawMessage.slice(0, ERROR_MESSAGE_MAX_CHARS)
      : rawMessage;
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? { code, message } : { message };
};

/**
 * Pool-owned query-trail ring buffer. Created by `PgBridgePool` when the
 * `queryTrail` option is enabled (and the `PGLITE_BRIDGE_QUERY_TRAIL=0`
 * kill switch is absent); shared by all `PgBridgeClient`s of the pool via
 * the bridge-options plumbing.
 */
export class QueryTrailRecorder {
  readonly #maxEntries: number;
  readonly #maxParamChars: number;
  readonly #redactParams: boolean;

  #ring: QueryTrailEntry[] = [];
  #nextSeq = 0;
  #nextClientId = 0;
  #droppedCount = 0;
  #startMs = performance.now();
  #overflowWarned = false;
  #disabledAfterSeq?: number;

  constructor(options: QueryTrailOptions = {}) {
    this.#maxEntries = options.maxEntries ?? DEFAULT_TRAIL_MAX_ENTRIES;
    this.#maxParamChars = options.maxParamChars ?? DEFAULT_TRAIL_MAX_PARAM_CHARS;
    this.#redactParams = options.redactParams === true;
  }

  /** Assign the next stable per-pool client ordinal. */
  registerClient(): number {
    return this.#nextClientId++;
  }

  /**
   * Record a submission. Never throws; after an internal capture error the
   * recorder is disabled and an inert handle is returned.
   */
  begin(clientId: number, sql: string, values?: readonly unknown[]): QueryTrailHandle {
    if (this.#disabledAfterSeq !== undefined) return INERT_HANDLE;
    try {
      const params = this.#renderParams(values);
      const entry: QueryTrailEntry = {
        seq: this.#nextSeq++,
        atMs: performance.now() - this.#startMs,
        clientId,
        sql: capSql(sql),
        params,
        kind: deriveKind(sql),
        status: 'pending',
      };
      this.#push(entry);
      return {
        settle: (outcome) => {
          if (entry.status === 'settled') return;
          entry.status = 'settled';
          // Rounded to 2 decimals so the human trail reads `0.66ms`, not a
          // full-precision float; the formatter renders the stored value as-is.
          entry.durationMs =
            Math.round((performance.now() - this.#startMs - entry.atMs) * 100) / 100;
          entry.rowCount = outcome.rowCount;
          if (outcome.error !== undefined) entry.error = previewError(outcome.error);
        },
      };
    } catch {
      return this.#disable();
    }
  }

  /** Snapshot of the current entries — a copy of the internal ring, so a
   *  retained reference is not mutated by later captures. */
  entries(): readonly QueryTrailEntry[] {
    return [...this.#ring];
  }

  meta(): QueryTrailMeta {
    return this.#disabledAfterSeq === undefined
      ? { droppedCount: this.#droppedCount }
      : { droppedCount: this.#droppedCount, disabledAfterSeq: this.#disabledAfterSeq };
  }

  /** Reset the trail: empties the ring, resets seq to 0 and the atMs
   *  baseline, clears dropped/disabled state and re-arms the one-time
   *  overflow warning. */
  clear(): void {
    this.#ring = [];
    this.#nextSeq = 0;
    this.#droppedCount = 0;
    this.#startMs = performance.now();
    this.#overflowWarned = false;
    this.#disabledAfterSeq = undefined;
  }

  /** Render params at capture time — redacted, or previewed one-by-one.
   *  Reading a hostile value's preview throws, which begin() turns into a
   *  capture-error disable. */
  #renderParams(values?: readonly unknown[]): string[] {
    if (values === undefined) return [];
    if (this.#redactParams) return values.map(() => '<redacted>');
    return values.map((value) => previewParam(value, this.#maxParamChars));
  }

  /** Append an entry, dropping the oldest and counting the drop when the
   *  ring is at capacity. The FIRST overflow warns once on stderr. */
  #push(entry: QueryTrailEntry): void {
    if (this.#ring.length >= this.#maxEntries) {
      this.#ring.shift();
      this.#droppedCount++;
      if (!this.#overflowWarned) {
        this.#overflowWarned = true;
        process.stderr.write(
          `[prisma-pglite-bridge] query trail overflowed ${this.#maxEntries} entries; ` +
            'oldest entries are being dropped.\n',
        );
      }
    }
    this.#ring.push(entry);
  }

  /** Append the sentinel entry, disable further capture for the run, and warn
   *  once on stderr. Returns the inert handle. */
  #disable(): QueryTrailHandle {
    const seq = this.#nextSeq++;
    this.#disabledAfterSeq = seq;
    this.#push({
      seq,
      atMs: performance.now() - this.#startMs,
      clientId: -1,
      sql: DISABLED_SENTINEL_SQL,
      params: [],
      kind: 'query',
      status: 'settled',
      // Settled entries carry a durationMs; the sentinel had no timed run, so 0
      // keeps the human formatter from rendering `undefinedms`.
      durationMs: 0,
    });
    process.stderr.write(
      '[prisma-pglite-bridge] query trail capture failed; trail disabled for this run.\n',
    );
    return INERT_HANDLE;
  }
}
