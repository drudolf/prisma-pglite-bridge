/**
 * node-pg-migrate — programmatic runner with an injected `dbClient`
 * (a checked-out bridge client). Exercises the migrations table,
 * transactional DDL, and the cross-instance advisory lock
 * (PG_MIGRATE_LOCK_ID via pg_advisory_lock) on PGlite; falls back to
 * `noLock` with a distinct detail line if only the lock is the problem.
 */
import { runner } from 'node-pg-migrate';
import type { CompatProbe } from './types.ts';

const MIGRATIONS_DIR = new URL('./fixtures/migrations', import.meta.url).pathname;

export const nodePgMigrate: CompatProbe = {
  name: 'node-pg-migrate',
  summary: 'programmatic up/down migrations with advisory-lock coordination',
  run: async ({ pool }) => {
    const details: string[] = [];
    const client = await pool.connect();
    const base = {
      dbClient: client as never,
      dir: MIGRATIONS_DIR,
      migrationsTable: 'pgmigrations',
      log: () => {},
    };
    try {
      let locked = true;
      try {
        await runner({ ...base, direction: 'up' as const });
      } catch (err) {
        // Distinguish "advisory lock unsupported" from a real failure.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/advisory|lock/i.test(msg)) throw err;
        locked = false;
        await runner({ ...base, direction: 'up' as const, noLock: true });
      }
      const t = await client.query(
        "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name = 'compat_migrate_items'",
      );
      if ((t.rows[0] as { c: number }).c !== 1) {
        return { status: 'fail', details: ['up ran but the migrated table is missing'] };
      }
      details.push(
        locked
          ? 'up migration with pg_advisory_lock coordination'
          : 'up migration (noLock — pg_advisory_lock unsupported)',
      );

      await runner({ ...base, direction: 'down' as const, ...(locked ? {} : { noLock: true }) });
      const gone = await client.query(
        "SELECT count(*)::int AS c FROM information_schema.tables WHERE table_name = 'compat_migrate_items'",
      );
      if ((gone.rows[0] as { c: number }).c !== 0) {
        return { status: 'fail', details: [...details, 'down did not drop the table'] };
      }
      details.push('down migration reverts, pgmigrations table maintained');

      return { status: 'pass', details };
    } finally {
      client.release();
    }
  },
};
