/**
 * pg-boss — job queue on the custom-`db` seam (`executeSql` wired to
 * `pool.query`). Exercises schema install (multi-statement DDL),
 * enqueue, fetch, and completion. Supervision and cron scheduling are
 * disabled so the probe leaves no background timers.
 */
import { PgBoss } from 'pg-boss';
import type { CompatProbe } from './types.ts';

export const pgBoss: CompatProbe = {
  name: 'pg-boss',
  summary: 'job queue: schema install, send, fetch, complete (custom-db seam)',
  run: async ({ pool }) => {
    const details: string[] = [];
    const boss = new PgBoss({
      db: { executeSql: (text: string, values?: unknown[]) => pool.query(text, values as never) },
      supervise: false,
      schedule: false,
    });
    const errors: string[] = [];
    boss.on('error', (err) => errors.push(err instanceof Error ? err.message : String(err)));

    try {
      await boss.start();
      details.push('schema installed via multi-statement DDL');

      const queue = 'compat-queue';
      await boss.createQueue(queue);
      const jobId = await boss.send(queue, { answer: 42 });
      if (!jobId) return { status: 'fail', details: [...details, 'send returned no job id'] };

      const jobs = await boss.fetch(queue);
      const job = jobs?.[0];
      if (!job || (job.data as { answer: number }).answer !== 42) {
        return { status: 'fail', details: [...details, `fetch returned ${JSON.stringify(jobs)}`] };
      }
      details.push('send → fetch round-trips a job with payload');

      await boss.complete(queue, job.id);
      const done = await pool.query('SELECT state FROM pgboss.job WHERE id = $1', [job.id]);
      details.push(`complete persists state '${done.rows[0]?.state}'`);

      if (errors.length > 0) {
        return { status: 'fail', details: [...details, `boss error events: ${errors.join('; ')}`] };
      }
      return { status: 'pass', details };
    } finally {
      await boss.stop({ graceful: false }).catch(() => {});
    }
  },
};
