/**
 * Query-trail formatter (design: .claude/plans/query-trail-design.md).
 *
 * Human format: a header line
 * `pglite-bridge query trail — <n> queries<, m dropped><, disabled after
 * entry N>` followed by one line per entry — seq, client tag, duration,
 * status (pending marked), kind label, SQL, params, error inline.
 * Transaction boundaries render as FLAT labeled entries (`BEGIN`,
 * `SAVEPOINT s1`, …) — never indent nesting (indent state is per-client
 * and breaks under concurrent-client interleaving).
 *
 * JSON format (`format: 'json'`): JSONL — first line is a header event
 * `{ type: 'trail-header', formatVersion, testName, droppedCount,
 * disabled }`, then one entry object per line.
 */
import type { QueryTrailEntry, QueryTrailError, QueryTrailMeta } from './query-trail.ts';

/** Bumped when the JSONL shape changes; agents key on it. */
export const TRAIL_FORMAT_VERSION = 1;

export interface FormatQueryTrailOptions {
  /** Rendered in the header (human) / header event (json). */
  testName?: string;
  /** Default `'human'`. */
  format?: 'human' | 'json';
}

/** The human header line. Segment order (each conditional): base count, then
 *  `, <m> dropped`, then `, disabled after entry <N>`, then ` — test "<name>"`.
 *  The count is deliberately always plural ("queries") — a branch-free choice.
 *  Header em-dash is U+2014. */
const humanHeader = (count: number, meta: QueryTrailMeta, testName: string | undefined): string => {
  let header = `pglite-bridge query trail — ${count} queries`;
  if (meta.droppedCount > 0) header += `, ${meta.droppedCount} dropped`;
  if (meta.disabledAfterSeq !== undefined)
    header += `, disabled after entry ${meta.disabledAfterSeq}`;
  if (testName !== undefined) header += ` — test "${testName}"`;
  return header;
};

/** One entry line: `#<seq> c<clientId> <ms|pending> <KIND> · <sql>[ · [params]]`.
 *  The params segment (with its leading ` · `) is omitted when empty. U+00B7
 *  separators. atMs is never rendered. */
const humanEntryLine = (entry: QueryTrailEntry): string => {
  const duration = entry.status === 'pending' ? 'pending' : `${entry.durationMs}ms`;
  const kind = entry.kind.toUpperCase();
  const base = `#${entry.seq} c${entry.clientId} ${duration} ${kind} · ${entry.sql}`;
  return entry.params.length === 0 ? base : `${base} · [${entry.params.join(', ')}]`;
};

/** The error continuation line (only for errored entries): four-space indent,
 *  `↳ error[ <code>]: <message>` — the code, when present, sits between
 *  `error` and the colon (`error 23505: …`); without a code the colon follows
 *  `error` directly (`error: …`). */
const humanErrorLine = (error: QueryTrailError): string =>
  `    ↳ error${error.code === undefined ? '' : ` ${error.code}`}: ${error.message}`;

const formatHuman = (
  entries: readonly QueryTrailEntry[],
  meta: QueryTrailMeta,
  testName: string | undefined,
): string => {
  const lines = [humanHeader(entries.length, meta, testName)];
  for (const entry of entries) {
    lines.push(humanEntryLine(entry));
    if (entry.error !== undefined) lines.push(humanErrorLine(entry.error));
  }
  return lines.join('\n');
};

const formatJson = (
  entries: readonly QueryTrailEntry[],
  meta: QueryTrailMeta,
  testName: string | undefined,
): string => {
  const header = {
    type: 'trail-header',
    formatVersion: TRAIL_FORMAT_VERSION,
    testName,
    droppedCount: meta.droppedCount,
    disabled: meta.disabledAfterSeq === undefined ? false : meta.disabledAfterSeq,
  };
  return [header, ...entries].map((line) => JSON.stringify(line)).join('\n');
};

export const formatQueryTrail = (
  entries: readonly QueryTrailEntry[],
  meta: QueryTrailMeta,
  options: FormatQueryTrailOptions = {},
): string =>
  options.format === 'json'
    ? formatJson(entries, meta, options.testName)
    : formatHuman(entries, meta, options.testName);
