import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type ConnectionShim,
  errorMessage,
  makeScenarioTypes,
  type Outcome,
  parityScenarioArb,
  pinnedDivergenceCaseArb,
  projectSettlement,
  type SequenceMessage,
  StockQuery,
  type StockQueryInstance,
  settlementScenarioArb,
} from './__tests__/property-arbitraries.ts';
import type { TypesLike } from './fast-array-parsers.ts';
import { FastQuery, type FastQueryField, type FastQueryResult } from './fast-query.ts';

// The connection-less shim is IDENTICAL for both sides (spec condition); only
// stock handlers accept it, and only the `this.rows` paths — which the
// generated single-shot cycles never enter — would invoke it.
const shim: ConnectionShim = { sync: () => {} };

const deliverToFast = (query: FastQuery, message: SequenceMessage): void => {
  switch (message.kind) {
    case 'rowDescription':
      query.handleRowDescription({ fields: message.fields });
      return;
    case 'dataRow':
      query.handleDataRow({ fields: message.values });
      return;
    case 'commandComplete':
      query.handleCommandComplete({ text: message.tag });
      return;
    case 'emptyQuery':
      query.handleEmptyQuery();
      return;
    case 'readyForQuery':
      query.handleReadyForQuery();
      return;
    case 'error':
      query.handleError(new Error(message.message));
      return;
  }
};

const deliverToStock = (stock: StockQueryInstance, message: SequenceMessage): void => {
  switch (message.kind) {
    case 'rowDescription':
      stock.handleRowDescription({ fields: message.fields });
      return;
    case 'dataRow':
      stock.handleDataRow({ fields: message.values });
      return;
    case 'commandComplete':
      stock.handleCommandComplete({ text: message.tag }, shim);
      return;
    case 'emptyQuery':
      stock.handleEmptyQuery(shim);
      return;
    case 'readyForQuery':
      stock.handleReadyForQuery(shim);
      return;
    case 'error':
      stock.handleError(new Error(message.message), shim);
      return;
  }
};

// Cold path by construction: empty fieldsCache, no submit — the receive-side
// handler interface is driven directly, like pg's connection would.
const makeFastQuery = (types: TypesLike): FastQuery =>
  new FastQuery(
    { name: 'prop_stmt', text: 'SELECT 1', values: [], types },
    new Map<string, FastQueryField[]>(),
  );

const settleOutcome = (promise: Promise<FastQueryResult>): Promise<Outcome> =>
  promise.then(
    (value): Outcome => ({ kind: 'resolved', projection: projectSettlement(value) }),
    (err: unknown): Outcome => ({ kind: 'rejected', message: errorMessage(err) }),
  );

const driveFast = async (
  messages: readonly SequenceMessage[],
  types: TypesLike,
): Promise<Outcome> => {
  const query = makeFastQuery(types);
  query.promise.catch(() => {});
  for (const message of messages) {
    try {
      deliverToFast(query, message);
    } catch (err) {
      // Three-valued outcome model (tribunal condition): a synchronous handler
      // throw is itself the recorded outcome.
      return { kind: 'handler-threw-synchronously', message: errorMessage(err) };
    }
  }
  return settleOutcome(query.promise);
};

const driveStock = (messages: readonly SequenceMessage[], types: TypesLike): Outcome => {
  const settlements: Outcome[] = [];
  const stock = new StockQuery({
    name: 'prop_stmt',
    text: 'SELECT 1',
    values: [],
    rowMode: 'array',
    types,
    callback: (err, result) => {
      settlements.push(
        err === null && result !== undefined
          ? { kind: 'resolved', projection: projectSettlement(result) }
          : { kind: 'rejected', message: errorMessage(err) },
      );
    },
  });
  for (const message of messages) {
    try {
      deliverToStock(stock, message);
    } catch (err) {
      return { kind: 'handler-threw-synchronously', message: errorMessage(err) };
    }
  }
  const first = settlements[0];
  expect(first, 'stock query settles exactly once per generated cycle').toBeDefined();
  expect(settlements).toHaveLength(1);
  return first as Outcome;
};

describe('FastQuery receive-side properties', () => {
  it('P4: settlement projection matches stock pg.Query across generated protocol cycles', async () => {
    await fc.assert(
      fc.asyncProperty(parityScenarioArb, async (scenario) => {
        const types = makeScenarioTypes(scenario.typesArm, scenario.throwOid);
        const stockOutcome = driveStock(scenario.messages, types);
        const fastOutcome = await driveFast(scenario.messages, types);

        expect(fastOutcome.kind).toBe(stockOutcome.kind);
        if (fastOutcome.kind === 'resolved' && stockOutcome.kind === 'resolved') {
          expect(fastOutcome.projection).toEqual(stockOutcome.projection);
        } else if (fastOutcome.kind === 'rejected' && stockOutcome.kind === 'rejected') {
          expect(fastOutcome.message).toBe(stockOutcome.message);
        }
      }),
      { numRuns: 500 },
    );
  });

  // PINNED NAMED DIVERGENCE (tribunal condition), asserted separately from P4:
  // stock Query lets a getTypeParser throw escape handleRowDescription
  // synchronously (result.js resolves field parsers inline); FastQuery buffers
  // it and rejects at ReadyForQuery by design (the client-wedge fix).
  it('pinned divergence: getTypeParser throw at RowDescription escapes stock synchronously, FastQuery rejects at RFQ', async () => {
    await fc.assert(
      fc.asyncProperty(pinnedDivergenceCaseArb, async ({ fields, rows, tag }) => {
        const types = makeScenarioTypes('throwing-get-type-parser', 23);

        const stock = new StockQuery({
          name: 'prop_stmt',
          text: 'SELECT 1',
          values: [],
          rowMode: 'array',
          types,
          callback: () => {},
        });
        expect(() => stock.handleRowDescription({ fields })).toThrow('type resolver boom');

        const query = makeFastQuery(types);
        query.promise.catch(() => {});
        expect(() => query.handleRowDescription({ fields })).not.toThrow();
        for (const values of rows) {
          expect(() => query.handleDataRow({ fields: values })).not.toThrow();
        }
        if (tag !== null) {
          query.handleCommandComplete({ text: tag });
        }
        query.handleReadyForQuery();
        await expect(query.promise).rejects.toThrow('type resolver boom');
      }),
    );
  });

  it('P5: the promise settles exactly once and stays immutable under post-settlement replay', async () => {
    await fc.assert(
      fc.asyncProperty(settlementScenarioArb, async (scenario) => {
        const types = makeScenarioTypes(scenario.typesArm, scenario.throwOid);
        const query = makeFastQuery(types);
        let settled = false;
        query.promise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );

        for (const message of scenario.messages) {
          expect(() => deliverToFast(query, message)).not.toThrow();
        }
        await Promise.resolve();
        expect(settled).toBe(true);

        const first = await query.promise.then(
          (value) => ({ kind: 'resolved' as const, value }),
          (reason: unknown) => ({ kind: 'rejected' as const, reason }),
        );
        const snapshot = first.kind === 'resolved' ? structuredClone(first.value) : null;

        for (const message of scenario.replay) {
          expect(() => deliverToFast(query, message)).not.toThrow();
        }

        const after = await query.promise.then(
          (value) => ({ kind: 'resolved' as const, value }),
          (reason: unknown) => ({ kind: 'rejected' as const, reason }),
        );
        expect(after.kind).toBe(first.kind);
        if (first.kind === 'resolved' && after.kind === 'resolved') {
          expect(Object.is(after.value, first.value)).toBe(true);
          // Straggler messages must not have grown the settled rows array.
          expect(after.value).toEqual(snapshot);
        } else if (first.kind === 'rejected' && after.kind === 'rejected') {
          // On rejection, partially parsed rows are never observable: the
          // settlement stays the same rejection, never a late resolve.
          expect(after.reason).toBe(first.reason);
        }
      }),
    );
  });
});

// Tripwire for pg version bumps: this suite drives the stock Query's handler
// set as the P4 reference; drift here invalidates the differential.
describe('pg seam contract — stock Query (tripwire)', () => {
  it('pg/lib/query.js exposes the receive-side handler set this suite drives', () => {
    const prototype = (StockQuery as unknown as { prototype: Record<string, unknown> }).prototype;
    for (const method of [
      'handleRowDescription',
      'handleDataRow',
      'handleCommandComplete',
      'handleEmptyQuery',
      'handleError',
      'handleReadyForQuery',
    ] as const) {
      expect(typeof prototype[method], `Query.prototype.${method}`).toBe('function');
    }
  });
});
