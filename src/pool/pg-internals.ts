/**
 * Centralized pg-internals seam. `FastQuery` and `PgBridgeClient` ride pg
 * internals beyond the documented Submittable API — the connection's
 * extended-protocol methods, its `parsedStatements` map, `prepareValue`, and
 * the active-query accessor. Every such read is typed or wrapped here so a pg
 * upgrade surfaces in ONE module, guarded by the `pg seam contract` tests in
 * fast-query.test.ts.
 */
import type pg from 'pg';
import pgUtils from 'pg/lib/utils.js';

/** pg's internal per-connection map of named prepared statements. pg uses it
 *  to skip Parse on repeat named-statement calls; the `pg seam contract` test
 *  is the drift tripwire for both `FastQuery` and `PgBridgeClient`'s
 *  DEALLOCATE eviction. */
export type PgParsedStatements = Record<string, string | undefined>;

/** The subset of pg's internal Connection the bridge drives directly:
 *  `FastQuery` for the extended-protocol fast path, `PgBridgeClient` for the
 *  piggybacked statement `Close`. */
export type FastQueryConnection = {
  stream: { cork?: () => void; uncork?: () => void };
  parsedStatements: PgParsedStatements;
  parse: (query: { text: string; name: string; types: number[] }) => void;
  bind: (config: {
    portal: string;
    statement: string;
    values: unknown[];
    binary: boolean;
    valueMapper: (value: unknown) => unknown;
  }) => void;
  describe: (msg: { type: string; name: string }) => void;
  execute: (config: { portal: string; rows: number }) => void;
  sync: () => void;
  sendCopyFail: (msg: string) => void;
};

/** pg's synchronous value serializer — maps user-supplied bind values and
 *  throws on unserializable input (circular structures, a throwing
 *  toPostgres). */
export const prepareValue: (value: unknown) => unknown = pgUtils.prepareValue;

/** pg's in-flight query via the non-deprecated internal accessor: the public
 *  `activeQuery` getter emits a deprecation warning on every read (removed in
 *  pg@9). `_getActiveQuery()` is what that getter delegates to (pg 8.22.0
 *  lib/client.js); the `_activeQuery` field read covers older 8.x minors that
 *  predate the helper. A pg upgrade that drops both is pinned by the
 *  `pg seam contract` test. */
export const getPgActiveQuery = (client: pg.Client): unknown => {
  const internals = client as unknown as {
    _getActiveQuery?: () => unknown;
    _activeQuery?: unknown;
  };
  /* v8 ignore next 3 — the field-read arm is for pre-_getActiveQuery pg 8.x minors */
  return typeof internals._getActiveQuery === 'function'
    ? internals._getActiveQuery()
    : internals._activeQuery;
};
