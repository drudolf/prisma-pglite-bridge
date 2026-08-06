import type pg from 'pg';
import type { TypesLike } from './fast-array-parsers.ts';
import { prepareValue } from './pg-internals.ts';

export type FastQueryField = { name: string; dataTypeID: number; format?: string };

export type FastQueryResult = {
  rows: unknown[][];
  fields: FastQueryField[];
  rowCount: number | null;
  command: string | null;
  oid: number | null;
};

type Parser = (raw: string) => unknown;

// Mirrors pg's Result command-tag regex: COMMAND [oid] [rows].
const COMMAND_TAG = /^([A-Za-z]+)(?: (\d+))?(?: (\d+))?/;

/**
 * A lean pg Submittable for the exact query shape `@prisma/adapter-pg`
 * emits when statement caching names a query: named statement,
 * `rowMode: 'array'`, caller-supplied `types`, extended protocol.
 *
 * Compared to pg's stock Query it skips the Describe round-trip on repeat
 * executions (result-field metadata is cached per statement name in a
 * per-client map), builds no `Result`/EventEmitter per query, and applies
 * parsers in one tight loop. Type semantics are untouched: parsers are
 * re-resolved from the CURRENT call's `types.getTypeParser` on every
 * execution — only the fields metadata is cached — so a caller-supplied
 * `types` object (including adapter-pg's per-query closure and the bridge's
 * fast-array wrapper) is always consulted.
 *
 * Rides pg internals beyond the documented Submittable seam
 * (`connection.parse/bind/describe/execute/sync`, `parsedStatements`,
 * `pg/lib/utils.js` prepareValue) — the `pg seam contract` tests in
 * fast-query.test.ts are the tripwire for pg version bumps. pg.Client
 * invokes exactly the handler set implemented here; it does not require an
 * EventEmitter. Neither the bridge nor adapter-pg uses pg's
 * query-cancellation API, which this class does not implement.
 *
 * @internal
 */
export class FastQuery implements pg.Submittable {
  readonly name: string;
  readonly text: string;
  // `deferred` holds the resolve/reject the settle path calls; `promise` is the
  // public handle (`PgBridgeClient` awaits it). Keep the two adjacent — promise's
  // initializer reads `this.deferred`, so deferred must be declared first.
  private readonly deferred = Promise.withResolvers<FastQueryResult>();
  readonly promise: Promise<FastQueryResult> = this.deferred.promise;

  private readonly values: unknown[];
  private readonly types: TypesLike;
  private readonly fieldsCache: Map<string, FastQueryField[]>;
  private fields: FastQueryField[] = [];
  private parsers: Parser[] = [];
  private rows: unknown[][] = [];
  private rowCount: number | null = null;
  private command: string | null = null;
  private oid: number | null = null;
  private describeSent = false;
  private fieldsReceived = false;
  private bufferedError: Error | undefined;
  private settled = false;

  /**
   * @param config  Already-validated fast-path arguments — `PgBridgeClient`
   *   gates on the adapter-pg shape before constructing.
   * @param fieldsCache  Client-owned field-metadata map, keyed by statement
   *   name and shared across FastQuery instances; `[]` is the NoData
   *   sentinel for statements without result columns.
   */
  constructor(
    config: { name: string; text: string; values?: unknown[]; types: TypesLike },
    fieldsCache: Map<string, FastQueryField[]>,
  ) {
    this.name = config.name;
    this.text = config.text;
    this.values = config.values ?? [];
    this.types = config.types;
    this.fieldsCache = fieldsCache;
  }

  /** Resolve one parser per column through the CURRENT call's `types`. */
  private applyFields(fields: FastQueryField[]): void {
    this.fields = fields;
    this.parsers = new Array(fields.length);
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i] as FastQueryField;
      this.parsers[i] = this.types.getTypeParser(field.dataTypeID, field.format ?? 'text');
    }
  }

  /**
   * Called by pg.Client when this query becomes active. Returns an Error
   * (never throws) for client-side validation failures — stock Query
   * parity. A synchronous serialization failure inside Bind or a warm-path
   * parser-resolution failure is buffered and returns null instead; the
   * recovery Sync's ReadyForQuery settles the promise (see the catches
   * below). Settling INSIDE submit would be premature: the promise (and
   * with it the client's submission chain) would clear while pg's
   * active-query slot still holds this query, and a release() in that
   * window would read as "bare Submittable in flight" and skip the
   * abandoned-transaction cleanup — leaking an open transaction and the
   * SessionLock (probe-verified).
   */
  submit(connection: pg.Connection): Error | null {
    // The extended-protocol methods, parsedStatements, and sendCopyFail this
    // path drives are declared onto pg.Connection by pg-internals' module
    // augmentation (pg omits them), so no cast is needed here; the `pg seam
    // contract` tests pin the runtime shape.
    const previous = connection.parsedStatements[this.name];
    if (previous !== undefined && previous !== this.text) {
      return new Error(
        `Prepared statements must be unique - '${this.name}' was used for a different statement`,
      );
    }

    const cachedFields = this.fieldsCache.get(this.name);
    connection.stream.cork?.();
    try {
      if (previous !== this.text) {
        connection.parse({ text: this.text, name: this.name, types: [] });
      }
      try {
        connection.bind({
          portal: '',
          statement: this.name,
          values: this.values,
          binary: false,
          valueMapper: prepareValue,
        });
      } catch (err) {
        // prepareValue maps user-supplied values synchronously and throws on
        // unserializable input (circular structures, a throwing toPostgres).
        // Without a catch the throw escapes pg's _pulseQueryQueue with
        // readyForQuery still false — wedging the client forever. Recover
        // with a bare Sync: the backend answers ReadyForQuery and pg pulses
        // the queue. The error is BUFFERED, not settled here — see the
        // submit() doc comment for why premature settlement leaks abandoned
        // transactions. Unlike stock pg, no Close for the just-parsed
        // statement: ParseComplete still records it in parsedStatements, so
        // closing it server-side would desync the parse-skip cache (26000
        // on the next execution); keeping it is exactly the cache's normal
        // warm state.
        this.bufferedError = err instanceof Error ? err : new Error(String(err));
        connection.sync();
        return null;
      }
      if (cachedFields === undefined) {
        this.describeSent = true;
        connection.describe({ type: 'P', name: '' });
      } else {
        try {
          this.applyFields(cachedFields);
        } catch (err) {
          // Parser resolution runs caller code (types.getTypeParser) — a
          // throw here would escape pg's _pulseQueryQueue with readyForQuery
          // still false, the same client-wedging failure mode as the Bind
          // catch above. Recover identically: buffer the error, bare Sync
          // (the backend discards the bound portal and answers
          // ReadyForQuery, which settles the rejection). The cached fields
          // entry stays — it is server truth; the failure belongs to this
          // call's types object, which is re-resolved on every execution by
          // design.
          this.bufferedError = err instanceof Error ? err : new Error(String(err));
          connection.sync();
          return null;
        }
      }
      connection.execute({ portal: '', rows: 0 });
      connection.sync();
    } finally {
      connection.stream.uncork?.();
    }
    return null;
  }

  /**
   * Cold path — first execution of a statement: cache its result-field
   * metadata under the statement name (later executions skip Describe) and
   * resolve this call's parsers.
   */
  handleRowDescription(msg: { fields: FastQueryField[] }): void {
    this.fieldsReceived = true;
    this.fieldsCache.set(this.name, msg.fields);
    try {
      this.applyFields(msg.fields);
    } catch (err) {
      // Called from pg's connection event handler — a throw would surface
      // as an uncaughtException. Buffer it; ReadyForQuery turns it into the
      // query's ordinary rejection (Execute/Sync are already on the wire,
      // so the protocol reaches RFQ on its own). The fields were cached
      // above on purpose: they are server truth, only this call's parser
      // resolution failed.
      this.bufferedError ??= err instanceof Error ? err : new Error(String(err));
    }
  }

  /** Parse one row through the per-column parsers resolved at submit or
   *  Describe time. */
  handleDataRow(msg: { fields: (string | null)[] }): void {
    // Straggler rows are dropped after a fatal error settled the query
    // (stock pg guards the same way) and after a buffered failure — a
    // failed applyFields leaves holes in `parsers`, so rows must not run
    // through it.
    if (this.settled || this.bufferedError) return;
    const data = msg.fields;
    const row: unknown[] = new Array(data.length);
    const parsers = this.parsers;
    try {
      for (let i = 0; i < data.length; i++) {
        const raw = data[i];
        row[i] = raw === null || raw === undefined ? null : (parsers[i] as Parser)(raw);
      }
    } catch (err) {
      // Type parsers are caller code. Stock pg catches parseRow throws and
      // rejects at ReadyForQuery (_canceledDueToError); mirror that with the
      // buffered-error path — a throw from the dataRow event handler would
      // otherwise be an uncaughtException. Partial rows are discarded by
      // settle(error).
      this.bufferedError = err instanceof Error ? err : new Error(String(err));
      return;
    }
    this.rows.push(row);
  }

  /** Extract `command` / `rowCount` / `oid` from the tag, mirroring pg's
   *  own Result parsing. */
  handleCommandComplete(msg: { text: string }): void {
    const match = COMMAND_TAG.exec(msg.text);
    /* v8 ignore start — command tags are server-generated and always match */
    // Stryker disable next-line ConditionalExpression: accept — Server-generated command tags always start with [A-Za-z]+ so COMMAND_TAG.exec never returns null; the !match guard is defensively unreachable and already marked /* v8 ignore next */.
    if (!match) return;
    /* v8 ignore stop */
    // The command group is mandatory in the regex — present whenever it matches.
    this.command = match[1] as string;
    if (match[3] !== undefined) {
      this.oid = Number.parseInt(match[2] as string, 10);
      this.rowCount = Number.parseInt(match[3], 10);
    } else if (match[2] !== undefined) {
      this.rowCount = Number.parseInt(match[2], 10);
    }
  }

  /** EmptyQueryResponse carries no fields and no command — nothing to
   *  record; settlement happens at ReadyForQuery. */
  handleEmptyQuery(): void {}

  /** Unreachable with `rows: 0` executions; buffered defensively. */
  handlePortalSuspended(): void {
    this.bufferedError ??= new Error('FastQuery received an unexpected PortalSuspended');
  }

  /** Stock parity: refuse COPY; the backend then errors the statement. */
  handleCopyInResponse(connection: Pick<pg.Connection, 'sendCopyFail'>): void {
    connection.sendCopyFail('No source stream defined');
  }

  /** Stock parity: ignore stray COPY data. */
  handleCopyData(_msg: { chunk: Buffer }): void {}

  /**
   * Settles immediately — fatal connection errors never deliver a
   * ReadyForQuery (stock Query settles its callback the same way). A
   * buffered first error wins over the fatal one: symmetric with
   * handleReadyForQuery's settlement, and stock parity — pg's Query
   * swaps in _canceledDueToError before invoking its callback. Only
   * this promise's rejection reason is chosen here; pg.Client records
   * its connection-error state before the active query's handler runs,
   * so teardown and pool eviction never depend on it.
   */
  handleError(error: Error): void {
    this.settle(this.bufferedError ?? error);
  }

  handleReadyForQuery(): void {
    if (this.bufferedError) {
      this.settle(this.bufferedError);
      return;
    }
    if (this.describeSent && !this.fieldsReceived && !this.settled) {
      // NoData: the statement has no result columns. Remember that, so the
      // next execution skips Describe like any other warm execution.
      this.fieldsCache.set(this.name, []);
    }
    this.settle();
  }

  /** Single settlement point; partial rows are discarded on any error. */
  private settle(error?: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (error) {
      // Stryker disable next-line ArrayDeclaration: accept — On the error path settle() rejects (rows are never included in a rejection), settled=true drops all straggler rows, and the resolve payload is unreachable after reject — so the cleared this.rows value is never read; hygiene-only clear.
      this.rows = [];
      this.deferred.reject(error);
      return;
    }
    this.deferred.resolve({
      rows: this.rows,
      fields: this.fields.map((field) => ({ ...field })),
      rowCount: this.rowCount,
      command: this.command,
      oid: this.oid,
    });
  }
}
