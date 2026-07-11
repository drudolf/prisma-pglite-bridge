/**
 * Centralized pg-internals seam. `FastQuery` and `PgBridgeClient` ride pg
 * internals beyond the documented Submittable API — the connection's
 * extended-protocol methods, its `parsedStatements` map, `sendCopyFail`,
 * `prepareValue`, and the active-query accessor. `@types/pg` omits or
 * mis-types every one of these, so the real runtime shape is DECLARED here
 * (module augmentation, not `as` casts) and pinned by the `pg seam contract`
 * tests in fast-query.test.ts, which exercise the live pg object. A pg upgrade
 * surfaces in this ONE module.
 */
import type pg from 'pg';
import pgUtils from 'pg/lib/utils.js';

/**
 * Augment pg's published types with the internal surface the bridge drives.
 * `@types/pg@8.20.0` (the latest DefinitelyTyped ships; runtime is pg@8.22.0)
 * omits `parsedStatements`, `sendCopyFail`, and `_getActiveQuery`/`_activeQuery`
 * outright, and types `parse`/`bind`/`describe`/`execute`/`close` only for the
 * two-arg internal caller — mistyping `binary`/`rows` as strings. These are not
 * pg's public contract at any version; the declarations below assert the real
 * pg@8.22.0 runtime shape that the `pg seam contract` tests verify. Overloads
 * (not replacements) — the stock two-arg signatures stay intact.
 */
declare module 'pg' {
  interface Connection {
    parsedStatements: Record<string, string | undefined>;
    sendCopyFail(message: string): void;
    parse(query: { text: string; name: string; types: number[] }): void;
    bind(config: {
      portal: string;
      statement: string;
      values: unknown[];
      binary: boolean;
      valueMapper: (value: unknown) => unknown;
    }): void;
    describe(msg: { type: 'P' | 'S'; name: string }): void;
    execute(config: { portal: string; rows: number }): void;
    close(msg: { type: 'S'; name: string }): void;
  }
  interface Client {
    _getActiveQuery?(): unknown;
    _activeQuery?: unknown;
  }
}

/** pg's synchronous value serializer — maps user-supplied bind values and
 *  throws on unserializable input (circular structures, a throwing
 *  toPostgres). */
export const prepareValue: (value: unknown) => unknown = pgUtils.prepareValue;

/** pg's in-flight query via the non-deprecated internal accessor: the public
 *  `activeQuery` getter emits a deprecation warning on every read (removed in
 *  pg@9). `_getActiveQuery()` is what that getter delegates to (pg 8.22.0
 *  lib/client.js); the `_activeQuery` field read covers older 8.x minors that
 *  predate the helper. Both are declared on `Client` above; a pg upgrade that
 *  drops them is pinned by the `pg seam contract` test. */
export const getPgActiveQuery = (client: pg.Client): unknown => {
  /* v8 ignore next 3 — the field-read arm is for pre-_getActiveQuery pg 8.x minors */
  return typeof client._getActiveQuery === 'function'
    ? client._getActiveQuery()
    : client._activeQuery;
};
