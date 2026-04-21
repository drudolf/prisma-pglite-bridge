/**
 * Stack-level memory probe shared by all benchmark adapters.
 *
 * Monkey-patches `pg.Client`, `pg.Connection`, and `pg.Result` (once per
 * process) and instruments PGlite / driver-adapter entry points to record
 * labelled memory snapshots at each stack stage: `scenario.start`,
 * `pg.send`, `firstRow`, `resultBuilt`, `afterExec`, etc. Scenarios call
 * `stackProbe.start(label)` before a query and `stop()` after; the
 * recorded stages become a {@link StackAttribution} trace the runner
 * aggregates. Exported as the singleton {@link stackProbe}.
 */
import { performance } from 'node:perf_hooks';
import type { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import Connection from 'pg/lib/connection.js';
import Result from 'pg/lib/result.js';
import type { MemorySnapshot, StackAttribution, StackAttributionStage } from './adapters/types.ts';

type RecordState = {
  adapter: string;
  startedAt: number;
  stages: StackAttributionStage[];
};

const snapshot = (): Omit<MemorySnapshot, 'label'> => {
  const m = process.memoryUsage();
  return {
    rss: m.rss,
    heapUsed: m.heapUsed,
    arrayBuffers: m.arrayBuffers,
  };
};

const withLabel = (label: string, snap: Omit<MemorySnapshot, 'label'>): MemorySnapshot => ({
  label,
  rss: snap.rss,
  heapUsed: snap.heapUsed,
  arrayBuffers: snap.arrayBuffers,
});

const queryLabelSymbol = Symbol.for('prisma-pglite-bridge.stackProbe.queryLabel');
const firstRowSeenSymbol = Symbol.for('prisma-pglite-bridge.stackProbe.firstRowSeen');
const connectionLabelSymbol = Symbol.for('prisma-pglite-bridge.stackProbe.connectionLabel');
const connectionStatsSymbol = Symbol.for('prisma-pglite-bridge.stackProbe.connectionStats');
const streamInstrumentedSymbol = Symbol.for('prisma-pglite-bridge.stackProbe.streamInstrumented');
const queryConnectionSymbol = Symbol.for('prisma-pglite-bridge.stackProbe.queryConnection');
const driverAdapterInstrumentedSymbol = Symbol.for(
  'prisma-pglite-bridge.stackProbe.driverAdapterInstrumented',
);
const resultLabelSymbol = Symbol.for('prisma-pglite-bridge.stackProbe.resultLabel');

type ProbeQuery = pg.Query & {
  [queryLabelSymbol]?: string;
  [firstRowSeenSymbol]?: boolean;
  [queryConnectionSymbol]?: ProbeConnection;
};

type ProbeConnection = pg.Client['connection'] & {
  [connectionLabelSymbol]?: string;
  [connectionStatsSymbol]?: {
    chunkCount: number;
    rawBytes: number;
    maxChunkBytes: number;
    firstChunkBytes: number | null;
    firstChunkRecorded: boolean;
  };
};

type ProbeResult = InstanceType<typeof Result> & {
  [resultLabelSymbol]?: string;
};

export class StackProbe {
  private currentLabel: string | null = null;
  private currentAdapter: string | null = null;
  private readonly records = new Map<string, RecordState>();
  private readonly instrumentedBridge = new WeakSet<object>();
  private readonly instrumentedDirect = new WeakSet<object>();
  private pgPatched = false;

  start(label: string, adapter: string): void {
    this.currentLabel = label;
    this.currentAdapter = adapter;
    this.records.set(label, {
      adapter,
      startedAt: performance.now(),
      stages: [],
    });
    this.record(label, 'scenario.start');
  }

  finish(label: string): void {
    this.record(label, 'scenario.end');
    if (this.currentLabel === label) {
      this.currentLabel = null;
      this.currentAdapter = null;
    }
  }

  async run<T>(label: string, adapter: string, fn: () => Promise<T>): Promise<T> {
    this.start(label, adapter);
    try {
      const value = await fn();
      this.record(label, 'query.promise.resolved');
      return value;
    } finally {
      this.finish(label);
    }
  }

  mark(
    label: string,
    stage: string,
    meta?: Record<string, number | string | boolean | null>,
  ): void {
    this.record(label, stage, meta);
  }

  take(label: string): StackAttribution | null {
    const record = this.records.get(label);
    if (!record) return null;
    this.records.delete(label);
    if (record.stages.length === 0) return null;

    let peakStage = record.stages[0];
    for (const stage of record.stages) {
      if (stage.snapshot.rss >= peakStage.snapshot.rss) peakStage = stage;
    }

    return {
      label,
      adapter: record.adapter,
      peakStage: peakStage.stage,
      peak: peakStage.snapshot,
      stages: record.stages,
    };
  }

  patchPg(): void {
    if (this.pgPatched) return;
    this.pgPatched = true;

    const probe = this;
    const clientProto = pg.Client.prototype as pg.Client['prototype'] & {
      query: (...args: unknown[]) => unknown;
    };
    const queryProto = pg.Query.prototype as ProbeQuery;
    const connectionProto = Connection.prototype as {
      attachListeners: (...args: unknown[]) => unknown;
    };
    const resultProto = Result.prototype as ProbeResult['prototype'] & {
      addFields: (...args: unknown[]) => unknown;
      addRow: (...args: unknown[]) => unknown;
      parseRow: (...args: unknown[]) => unknown;
      _parseRowAsArray: (...args: unknown[]) => unknown;
    };

    const originalClientQuery = clientProto.query;
    clientProto.query = function patchedClientQuery(...args: unknown[]) {
      const label = probe.currentLabel;
      if (label) {
        probe.record(label, 'pg.client.query.start');
        const client = this as pg.Client & {
          connection?: ProbeConnection;
          _activeQuery?: ProbeQuery;
          _queryQueue?: ProbeQuery[];
        };
        const connection = client.connection;
        if (connection) {
          connection[connectionLabelSymbol] = label;
          connection[connectionStatsSymbol] = {
            chunkCount: 0,
            rawBytes: 0,
            maxChunkBytes: 0,
            firstChunkBytes: null,
            firstChunkRecorded: false,
          };
        }
      }

      const result = originalClientQuery.apply(this, args);
      if (label) {
        const client = this as pg.Client & {
          connection?: ProbeConnection;
          _activeQuery?: ProbeQuery;
          _queryQueue?: ProbeQuery[];
        };
        const candidate = client._activeQuery ?? client._queryQueue?.at(-1);
        if (candidate) {
          candidate[queryLabelSymbol] = label;
          if (client.connection) {
            candidate[queryConnectionSymbol] = client.connection;
          }
        }
      }
      return result;
    };

    const originalHandleRowDescription = queryProto.handleRowDescription;
    queryProto.handleRowDescription = function patchedHandleRowDescription(
      ...args: Parameters<typeof originalHandleRowDescription>
    ) {
      const label = this[queryLabelSymbol];
      if (label) {
        const result = this._result as ProbeResult | undefined;
        if (result) {
          result[resultLabelSymbol] = label;
        }
        probe.record(label, 'pg.query.row_description');
      }
      return originalHandleRowDescription.apply(this, args);
    };

    const originalHandleDataRow = queryProto.handleDataRow;
    queryProto.handleDataRow = function patchedHandleDataRow(
      ...args: Parameters<typeof originalHandleDataRow>
    ) {
      const label = this[queryLabelSymbol];
      if (label && !this[firstRowSeenSymbol]) {
        this[firstRowSeenSymbol] = true;
        probe.record(label, 'pg.query.first_data_row');
      }
      return originalHandleDataRow.apply(this, args);
    };

    const originalHandleCommandComplete = queryProto.handleCommandComplete;
    queryProto.handleCommandComplete = function patchedHandleCommandComplete(
      ...args: Parameters<typeof originalHandleCommandComplete>
    ) {
      const label = this[queryLabelSymbol];
      if (label) {
        probe.record(label, 'pg.query.command_complete');
      }
      return originalHandleCommandComplete.apply(this, args);
    };

    const originalHandleReadyForQuery = queryProto.handleReadyForQuery;
    queryProto.handleReadyForQuery = function patchedHandleReadyForQuery(
      ...args: Parameters<typeof originalHandleReadyForQuery>
    ) {
      const label = this[queryLabelSymbol];
      if (label) {
        const connection = this[queryConnectionSymbol];
        const stats = connection?.[connectionStatsSymbol];
        if (stats) {
          probe.record(label, 'pg.transport.end', {
            chunkCount: stats.chunkCount,
            rawBytes: stats.rawBytes,
            maxChunkBytes: stats.maxChunkBytes,
          });
        }
        probe.record(label, 'pg.query.ready_for_query');
        if (connection) {
          delete connection[connectionLabelSymbol];
          delete connection[connectionStatsSymbol];
        }
        delete this[queryConnectionSymbol];
      }
      return originalHandleReadyForQuery.apply(this, args);
    };

    const originalAttachListeners = connectionProto.attachListeners;
    connectionProto.attachListeners = function patchedAttachListeners(
      ...args: Parameters<typeof originalAttachListeners>
    ) {
      const stream = args[0] as NodeJS.ReadableStream & {
        [streamInstrumentedSymbol]?: boolean;
        on: (event: string, listener: (...args: unknown[]) => void) => unknown;
      };

      if (stream && !stream[streamInstrumentedSymbol]) {
        stream[streamInstrumentedSymbol] = true;
        stream.on('data', (chunk: Buffer | Uint8Array) => {
          const connection = this as ProbeConnection;
          const label = connection[connectionLabelSymbol];
          const stats = connection[connectionStatsSymbol];
          if (!label || !stats) return;

          const size = chunk.byteLength;
          stats.chunkCount += 1;
          stats.rawBytes += size;
          stats.maxChunkBytes = Math.max(stats.maxChunkBytes, size);

          if (!stats.firstChunkRecorded) {
            stats.firstChunkRecorded = true;
            stats.firstChunkBytes = size;
            probe.record(label, 'pg.transport.first_chunk', {
              chunkBytes: size,
            });
          }
        });
      }

      return originalAttachListeners.apply(this, args);
    };

    const originalAddFields = resultProto.addFields;
    resultProto.addFields = function patchedAddFields(
      ...args: Parameters<typeof originalAddFields>
    ) {
      const label = this[resultLabelSymbol];
      const result = originalAddFields.apply(this, args);
      if (label) {
        probe.record(label, 'pg.result.add_fields');
      }
      return result;
    };

    const originalParseRowAsArray = resultProto._parseRowAsArray;
    resultProto._parseRowAsArray = function patchedParseRowAsArray(
      ...args: Parameters<typeof originalParseRowAsArray>
    ) {
      const row = originalParseRowAsArray.apply(this, args);
      const label = this[resultLabelSymbol];
      if (label) {
        probe.record(label, 'pg.result.parse_row');
      }
      return row;
    };

    const originalParseRow = resultProto.parseRow;
    resultProto.parseRow = function patchedParseRow(...args: Parameters<typeof originalParseRow>) {
      const row = originalParseRow.apply(this, args);
      const label = this[resultLabelSymbol];
      if (label) {
        probe.record(label, 'pg.result.parse_row');
      }
      return row;
    };

    const originalAddRow = resultProto.addRow;
    resultProto.addRow = function patchedAddRow(...args: Parameters<typeof originalAddRow>) {
      const result = originalAddRow.apply(this, args);
      const label = this[resultLabelSymbol];
      if (label) {
        probe.record(label, 'pg.result.add_row');
      }
      return result;
    };
  }

  instrumentBridgePglite(pglite: PGlite): void {
    if (this.instrumentedBridge.has(pglite)) return;
    this.instrumentedBridge.add(pglite);

    const originalQuery = pglite.query.bind(pglite);
    pglite.query = (async (...args: Parameters<typeof pglite.query>) => {
      const label = this.currentLabel;
      if (!label) {
        return originalQuery(...args);
      }

      this.record(label, 'bridge.pglite.query.start');
      const result = await originalQuery(...args);
      this.record(label, 'bridge.pglite.query.end', {
        rowCount: result.rows.length,
        fieldCount: result.fields.length,
      });
      return result;
    }) as typeof pglite.query;

    const original = pglite.execProtocolRawStream.bind(pglite);
    pglite.execProtocolRawStream = (async (
      message: Uint8Array,
      options: { onRawData: (data: Uint8Array) => void },
    ) => {
      const label = this.currentLabel;
      if (!label) {
        return original(message, options);
      }

      let firstChunk = true;
      let chunkCount = 0;
      let rawBytes = 0;
      let maxChunkBytes = 0;
      this.record(label, 'bridge.exec_protocol.start', {
        messageBytes: message.byteLength,
      });

      return original(message, {
        ...options,
        onRawData: (chunk: Uint8Array) => {
          chunkCount += 1;
          rawBytes += chunk.byteLength;
          maxChunkBytes = Math.max(maxChunkBytes, chunk.byteLength);
          if (firstChunk) {
            firstChunk = false;
            this.record(label, 'bridge.exec_protocol.first_chunk', {
              chunkBytes: chunk.byteLength,
            });
          }
          options.onRawData(chunk);
        },
      }).finally(() => {
        this.record(label, 'bridge.exec_protocol.end', {
          chunkCount,
          rawBytes,
          maxChunkBytes,
        });
      });
    }) as typeof pglite.execProtocolRawStream;
  }

  instrumentDirectPglite(pglite: PGlite): void {
    if (this.instrumentedDirect.has(pglite)) return;
    this.instrumentedDirect.add(pglite);

    const original = pglite.query.bind(pglite);
    pglite.query = (async (...args: Parameters<typeof pglite.query>) => {
      const label = this.currentLabel;
      if (!label) {
        return original(...args);
      }

      this.record(label, 'direct.pglite.query.start');
      const result = await original(...args);
      this.record(label, 'direct.pglite.query.end', {
        rowCount: result.rows.length,
        fieldCount: result.fields.length,
      });
      return result;
    }) as typeof pglite.query;
  }

  instrumentDriverAdapter(queryable: object): void {
    let proto: Record<PropertyKey, unknown> | null = Object.getPrototypeOf(queryable);

    while (proto && proto !== Object.prototype) {
      const queryRaw = proto.queryRaw;
      const performIO = proto.performIO;

      if (
        typeof queryRaw === 'function' &&
        typeof performIO === 'function' &&
        proto[driverAdapterInstrumentedSymbol] !== true
      ) {
        proto[driverAdapterInstrumentedSymbol] = true;

        const originalQueryRaw = queryRaw as (this: object, ...args: unknown[]) => Promise<unknown>;
        const originalPerformIO = performIO as (
          this: object,
          ...args: unknown[]
        ) => Promise<unknown>;
        const probe = this;

        proto.queryRaw = async function patchedQueryRaw(this: object, ...args: unknown[]) {
          const label = probe.currentLabel;
          if (label) probe.record(label, 'driver_adapter.query_raw.start');
          const result = await originalQueryRaw.apply(this, args);
          if (label) probe.record(label, 'driver_adapter.query_raw.end');
          return result;
        };

        proto.performIO = async function patchedPerformIO(this: object, ...args: unknown[]) {
          const label = probe.currentLabel;
          if (label) probe.record(label, 'driver_adapter.perform_io.start');
          const result = await originalPerformIO.apply(this, args);
          if (label) probe.record(label, 'driver_adapter.perform_io.end');
          return result;
        };

        return;
      }

      proto = Object.getPrototypeOf(proto);
    }
  }

  private record(
    label: string,
    stage: string,
    meta?: Record<string, number | string | boolean | null>,
  ): void {
    const record = this.records.get(label);
    if (!record) return;
    record.stages.push({
      stage,
      tMs: performance.now() - record.startedAt,
      snapshot: withLabel(`${label}:${stage}`, snapshot()),
      meta: meta ?? null,
    });
  }
}

export const stackProbe = new StackProbe();
