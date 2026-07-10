/**
 * pg-copy-streams — COPY FROM STDIN / COPY TO STDOUT over the wire.
 * The duplex has no CopyInResponse/CopyData handling today, so the
 * expected failure mode is a WEDGE, not a throw — every step runs
 * under its own short deadline.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import type { CompatProbe } from './types.ts';
import { withTimeout } from './types.ts';

export const pgCopyStreams: CompatProbe = {
  name: 'pg-copy-streams',
  summary: 'bulk load/dump via COPY FROM STDIN / COPY TO STDOUT',
  run: async ({ pool }) => {
    const details: string[] = [];
    const client = await pool.connect();
    try {
      await client.query('CREATE TABLE copy_items (n INT, label TEXT)');

      const ingest = client.query(copyFrom('COPY copy_items (n, label) FROM STDIN'));
      const rows = Array.from({ length: 100 }, (_, i) => `${i + 1}\titem-${i + 1}\n`);
      await withTimeout(8_000, 'COPY FROM STDIN', pipeline(Readable.from(rows), ingest));
      const count = await withTimeout(
        5_000,
        'post-COPY count',
        client.query('SELECT count(*)::int AS c FROM copy_items'),
      );
      if ((count.rows[0] as { c: number }).c !== 100) {
        return { status: 'fail', details: [`COPY IN loaded ${count.rows[0]?.c} of 100 rows`] };
      }
      details.push('COPY FROM STDIN loaded 100 rows');

      const dump = client.query(copyTo('COPY copy_items (n, label) TO STDOUT'));
      let bytes = 0;
      let lines = 0;
      await withTimeout(
        8_000,
        'COPY TO STDOUT',
        (async () => {
          for await (const chunk of dump) {
            bytes += (chunk as Buffer).length;
            lines += (chunk as Buffer).toString().split('\n').filter(Boolean).length;
          }
        })(),
      );
      if (lines !== 100) {
        return { status: 'fail', details: [...details, `COPY OUT returned ${lines} of 100 rows`] };
      }
      details.push(`COPY TO STDOUT streamed 100 rows (${bytes} bytes)`);

      return { status: 'pass', details };
    } finally {
      client.release();
    }
  },
};
