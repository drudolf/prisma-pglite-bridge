/**
 * pg-query-stream — Readable-stream rows over pg-cursor. The async
 * iteration path is what kysely `.stream()` and friends build on.
 */
import QueryStream from 'pg-query-stream';
import type { CompatProbe } from './types.ts';

export const pgQueryStream: CompatProbe = {
  name: 'pg-query-stream',
  summary: 'Readable row stream (async iteration, backpressure) over pg-cursor',
  run: async ({ pool }) => {
    const details: string[] = [];
    const client = await pool.connect();
    try {
      const stream = client.query(
        new QueryStream('SELECT n AS id FROM generate_series(1, 500) AS n', [], {
          batchSize: 100,
        }),
      );
      let total = 0;
      let lastId = 0;
      for await (const row of stream) {
        total++;
        lastId = (row as { id: number }).id;
      }
      if (total !== 500 || lastId !== 500) {
        return {
          status: 'fail',
          details: [`expected 500 ordered rows, got ${total} (last ${lastId})`],
        };
      }
      details.push('streamed 500 rows via async iteration (batchSize 100)');

      // Early destroy must not wedge the session.
      const second = client.query(
        new QueryStream('SELECT n FROM generate_series(1, 500) AS n', [], { batchSize: 50 }),
      );
      let seen = 0;
      for await (const _row of second) {
        if (++seen >= 60) break; // break destroys the stream mid-portal
      }
      const after = await client.query('SELECT 1 AS ok');
      if (after.rows[0]?.ok !== 1) {
        return { status: 'fail', details: ['early stream destroy left the client unusable'] };
      }
      details.push('early stream destroy mid-portal, client stays usable');

      return { status: 'pass', details };
    } finally {
      client.release();
    }
  },
};
