/**
 * pg-cursor — row-limited portal reads (Execute(n) + Flush). Rides the
 * duplex Flush-boundary support; none of the native PGlite drivers can
 * do this. Also covered by src/__tests__/integration/row-limited-queries;
 * probed here so the compat matrix is self-contained.
 */
import Cursor from 'pg-cursor';
import type { CompatProbe } from './types.ts';

export const pgCursor: CompatProbe = {
  name: 'pg-cursor',
  summary: 'paged reads via Execute(n)+Flush portal suspension',
  run: async ({ pool }) => {
    const details: string[] = [];
    const client = await pool.connect();
    try {
      await client.query(
        'CREATE TABLE cursor_items AS SELECT n AS id FROM generate_series(1, 200) AS n',
      );

      const cursor = client.query(new Cursor('SELECT id FROM cursor_items ORDER BY id'));
      let total = 0;
      let batches = 0;
      for (;;) {
        const rows = await cursor.read(50);
        if (rows.length === 0) break;
        batches++;
        total += rows.length;
      }
      await cursor.close();
      if (total !== 200 || batches !== 4) {
        return {
          status: 'fail',
          details: [`expected 200 rows in 4 batches, got ${total} in ${batches}`],
        };
      }
      details.push('paged 200 rows in 4×50 batches, exhausted and closed');

      // Early close mid-stream must free the portal and keep the client usable.
      const second = client.query(new Cursor('SELECT id FROM cursor_items ORDER BY id'));
      const first10 = await second.read(10);
      await second.close();
      const after = await client.query('SELECT 1 AS ok');
      if (first10.length !== 10 || after.rows[0]?.ok !== 1) {
        return { status: 'fail', details: ['early close left the client unusable'] };
      }
      details.push('early close mid-stream, client stays usable');

      return { status: 'pass', details };
    } finally {
      client.release();
    }
  },
};
