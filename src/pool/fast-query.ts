import pgUtils from 'pg/lib/utils.js';

export type FastQueryField = { name: string; dataTypeID: number; format?: string };

export type FastQueryResult = {
  rows: unknown[][];
  fields: FastQueryField[];
  rowCount: number | null;
  command: string | null;
  oid: number | null;
};

type Parser = (raw: string) => unknown;

export type FastQueryTypes = { getTypeParser: (oid: number, format?: string) => Parser };

type FastQueryConnection = {
  stream: { cork?: () => void; uncork?: () => void };
  parsedStatements: Record<string, string | undefined>;
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
export class FastQuery {
  readonly name: string;
  readonly text: string;
  readonly promise: Promise<FastQueryResult>;

  private readonly values: unknown[];
  private readonly types: FastQueryTypes;
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
  private resolvePromise!: (result: FastQueryResult) => void;
  private rejectPromise!: (error: Error) => void;

  /**
   * @param config  Already-validated fast-path arguments — `PgBridgeClient`
   *   gates on the adapter-pg shape before constructing.
   * @param fieldsCache  Client-owned field-metadata map, keyed by statement
   *   name and shared across FastQuery instances; `[]` is the NoData
   *   sentinel for statements without result columns.
   */
  constructor(
    config: { name: string; text: string; values?: unknown[]; types: FastQueryTypes },
    fieldsCache: Map<string, FastQueryField[]>,
  ) {
    this.name = config.name;
    this.text = config.text;
    this.values = config.values ?? [];
    this.types = config.types;
    this.fieldsCache = fieldsCache;
    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
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
   * (never throws) for client-side validation failures — stock Query parity.
   */
  submit(connection: FastQueryConnection): Error | null {
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
          valueMapper: pgUtils.prepareValue,
        });
      } catch (err) {
        // prepareValue maps user-supplied values synchronously and throws on
        // unserializable input (circular structures, a throwing toPostgres).
        // Without a catch the throw escapes pg's _pulseQueryQueue with
        // readyForQuery still false — wedging the client forever. Recover
        // with a bare Sync: the backend answers ReadyForQuery and pg pulses
        // the queue. Unlike stock pg, no Close for the just-parsed statement:
        // ParseComplete still records it in parsedStatements, so closing it
        // server-side would desync the parse-skip cache (26000 on the next
        // execution); keeping it is exactly the cache's normal warm state.
        connection.sync();
        this.settle(err instanceof Error ? err : new Error(String(err)));
        return null;
      }
      if (cachedFields === undefined) {
        this.describeSent = true;
        connection.describe({ type: 'P', name: '' });
      } else {
        this.applyFields(cachedFields);
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
    this.applyFields(msg.fields);
  }

  /** Parse one row through the per-column parsers resolved at submit or
   *  Describe time. */
  handleDataRow(msg: { fields: (string | null)[] }): void {
    /* v8 ignore next 2 — defensive: a straggler row after a fatal error has
       no parsers to run through; stock pg guards the same way. */
    if (this.settled) return;
    const data = msg.fields;
    const row: unknown[] = new Array(data.length);
    const parsers = this.parsers;
    for (let i = 0; i < data.length; i++) {
      const raw = data[i];
      row[i] = raw === null || raw === undefined ? null : (parsers[i] as Parser)(raw);
    }
    this.rows.push(row);
  }

  /** Extract `command` / `rowCount` / `oid` from the tag, mirroring pg's
   *  own Result parsing. */
  handleCommandComplete(msg: { text: string }): void {
    const match = COMMAND_TAG.exec(msg.text);
    /* v8 ignore next — command tags are server-generated and always match */
    if (!match) return;
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
  handleCopyInResponse(connection: Pick<FastQueryConnection, 'sendCopyFail'>): void {
    connection.sendCopyFail('No source stream defined');
  }

  /** Stock parity: ignore stray COPY data. */
  handleCopyData(_msg: { chunk: Buffer }): void {}

  /**
   * Settles immediately — fatal connection errors never deliver a
   * ReadyForQuery (stock Query settles its callback the same way).
   */
  handleError(error: Error): void {
    this.settle(error);
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
      this.rows = [];
      this.rejectPromise(error);
      return;
    }
    this.resolvePromise({
      rows: this.rows,
      fields: this.fields,
      rowCount: this.rowCount,
      command: this.command,
      oid: this.oid,
    });
  }
}
