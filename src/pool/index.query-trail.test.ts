import { PGlite } from '@electric-sql/pglite';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setupPGlite } from '../__tests__/pglite.ts';
import { PGliteBridge } from '../pglite-bridge/index.ts';
import { PgBridgePool } from './index.ts';
import type { QueryTrailEntry } from './query-trail.ts';

// Red-phase TDD spec for wiring the query trail through the pool, client, and
// bridge (design: .claude/plans/query-trail-design.md §4 capture + §5/§7
// wiring bullets). The `queryTrail` option and `pool.queryTrail()` /
// `pool.clearQueryTrail()` accessors are stubbed (throwing 'not implemented'),
// so every test here is RED until the feature lands.
//
// Mirrors index.fast-query-path.test.ts: a fresh in-memory PGlite per pool
// unless a scenario needs sharing, each pool torn down in finally.

const pglite = await setupPGlite();

const entriesBySql = (entries: readonly QueryTrailEntry[], needle: string): QueryTrailEntry[] =>
  entries.filter((e) => e.sql.includes(needle));

describe('PgBridgePool — query trail wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures a plain query and a parameterized query with the right shape', async () => {
    const pool = new PgBridgePool({ pglite, queryTrail: true });
    try {
      const plain = await pool.query('SELECT 1 AS x');
      expect(plain.rows).toEqual([{ x: 1 }]);

      const param = await pool.query('SELECT $1::int AS n', [7]);
      expect(param.rows).toEqual([{ n: 7 }]);

      const trail = pool.queryTrail();
      const plainEntry = entriesBySql(trail, 'SELECT 1 AS x')[0];
      const paramEntry = entriesBySql(trail, 'SELECT $1::int AS n')[0];

      expect(plainEntry).toBeDefined();
      expect(plainEntry?.status).toBe('settled');
      expect(plainEntry?.kind).toBe('query');
      expect(plainEntry?.rowCount).toBe(1);
      expect(plainEntry?.params).toEqual([]);

      expect(paramEntry).toBeDefined();
      expect(paramEntry?.status).toBe('settled');
      expect(paramEntry?.params).toEqual(['7']);
      expect(paramEntry?.rowCount).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it('preserves submission order as seq order', async () => {
    const pool = new PgBridgePool({ pglite, queryTrail: true });
    try {
      await pool.query('SELECT 100 AS a');
      await pool.query('SELECT 200 AS b');
      await pool.query('SELECT 300 AS c');

      const trail = pool.queryTrail();
      const seqs = trail.map((e) => e.seq);
      // seq is strictly increasing in submission order.
      const sorted = [...seqs].sort((x, y) => x - y);
      expect(seqs).toEqual(sorted);

      const ordered = trail
        .filter((e) => /SELECT \d00 AS/.test(e.sql))
        .sort((x, y) => x.seq - y.seq)
        .map((e) => e.sql);
      expect(ordered).toEqual(['SELECT 100 AS a', 'SELECT 200 AS b', 'SELECT 300 AS c']);
    } finally {
      await pool.end();
    }
  });

  it('stamps distinct clientIds for entries from two checked-out clients', async () => {
    const pool = new PgBridgePool({ pglite, max: 2, queryTrail: true });
    let a: pg.PoolClient | undefined;
    let b: pg.PoolClient | undefined;
    try {
      a = await pool.connect();
      b = await pool.connect();

      await a.query('SELECT 1 AS from_a');
      await b.query('SELECT 1 AS from_b');

      const trail = pool.queryTrail();
      const fromA = entriesBySql(trail, 'from_a')[0];
      const fromB = entriesBySql(trail, 'from_b')[0];

      expect(fromA).toBeDefined();
      expect(fromB).toBeDefined();
      expect(fromA?.clientId).not.toBe(fromB?.clientId);
    } finally {
      a?.release();
      b?.release();
      await pool.end();
    }
  });

  it('captures a FastQuery-path query (adapter-pg shape) with its text and values', async () => {
    const pool = new PgBridgePool({ pglite, queryTrail: true });
    try {
      const client = await pool.connect();
      try {
        // The exact shape @prisma/adapter-pg emits when statement caching
        // names a query: named + rowMode array + caller types. This rides the
        // fast path (mirrors index.fast-query-path.test.ts's fastShapeQuery).
        const fastShape = {
          name: 'qt_fastq',
          text: 'SELECT $1::int AS n',
          values: [7],
          rowMode: 'array' as const,
          types: pg.types,
        };
        const result = await client.query(fastShape);
        expect(result.rows).toEqual([[7]]);

        const entry = entriesBySql(pool.queryTrail(), 'SELECT $1::int AS n')[0];
        expect(entry).toBeDefined();
        expect(entry?.status).toBe('settled');
        expect(entry?.sql).toBe('SELECT $1::int AS n');
        expect(entry?.params).toEqual(['7']);
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('captures a failing query with error.code and message, and still rejects the caller', async () => {
    const pool = new PgBridgePool({ pglite, queryTrail: true });
    try {
      // A syntax error rejects for the caller exactly as before — capture must
      // not alter behavior.
      await expect(pool.query('SELECT nonsense syntax !!')).rejects.toMatchObject({
        code: '42601',
      });

      const entry = entriesBySql(pool.queryTrail(), 'nonsense syntax')[0];
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('settled');
      expect(entry?.error?.code).toBe('42601');
      expect(typeof entry?.error?.message).toBe('string');
      expect(entry?.error?.message.length).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });

  it('derives transaction kinds for statements on a checked-out client', async () => {
    const pool = new PgBridgePool({ pglite, queryTrail: true });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SAVEPOINT sp1');
        await client.query('ROLLBACK TO SAVEPOINT sp1');
        await client.query('RELEASE SAVEPOINT sp1');
        await client.query('COMMIT');

        const byKind = new Map(
          pool
            .queryTrail()
            .filter((e) => e.kind !== 'query')
            .map((e) => [e.sql.trim().toUpperCase(), e.kind]),
        );
        expect(byKind.get('BEGIN')).toBe('begin');
        expect(byKind.get('SAVEPOINT SP1')).toBe('savepoint');
        expect(byKind.get('ROLLBACK TO SAVEPOINT SP1')).toBe('rollback-to');
        expect(byKind.get('RELEASE SAVEPOINT SP1')).toBe('release');
        expect(byKind.get('COMMIT')).toBe('commit');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('[tribunal] never captures the pool-internal teardown ROLLBACK the user did not issue', async () => {
    // A local instance so the abandoned-transaction cleanup is isolated to
    // this pool (the pool's 'release' listener issues an internal ROLLBACK
    // below the client's query() layer — it must NOT appear in the trail).
    const local = new PGlite();
    const pool = new PgBridgePool({ pglite: local, max: 2, queryTrail: true });
    let recovery: pg.PoolClient | undefined;
    const swallowAbandon = (w: Error): void => {
      // The abandoned-transaction warning is expected here.
      if (w.name === 'PGliteBridgeAbandonedTransactionWarning') return;
    };
    process.on('warning', swallowAbandon);
    try {
      const a = await pool.connect();
      await a.query('CREATE TABLE trail_tx (id int)');
      await a.query('BEGIN');
      await a.query('INSERT INTO trail_tx VALUES (1)');
      // Plain release WITHOUT COMMIT/ROLLBACK — the pool issues its own
      // internal recovery ROLLBACK below the client layer.
      a.release();

      // Drive the recycled client so the internal cleanup has certainly run.
      recovery = await pool.connect();
      await recovery.query('SELECT 1 AS drained');

      const trail = pool.queryTrail();
      // The user's own statements are present…
      expect(entriesBySql(trail, 'BEGIN')).toHaveLength(1);
      expect(entriesBySql(trail, 'INSERT INTO trail_tx')).toHaveLength(1);
      // …but the pool-internal recovery ROLLBACK is NOT captured. No entry the
      // user did not issue may carry kind 'rollback'.
      expect(trail.filter((e) => e.kind === 'rollback')).toEqual([]);
    } finally {
      process.off('warning', swallowAbandon);
      // Clear any leaked transaction before teardown, then close the local
      // instance directly (deterministic barrier).
      await recovery?.query('ROLLBACK').catch(() => {});
      recovery?.release();
      await pool.end();
      await local.query('SELECT 1').catch(() => {});
      if (!local.closed) await local.close();
    }
  });

  it('captures a text-bearing Submittable (pg.Query) with its text', async () => {
    const pool = new PgBridgePool({ pglite, queryTrail: true });
    try {
      const client = await pool.connect();
      try {
        const query = new pg.Query('SELECT 1 AS via_submittable');
        const result = await new Promise<pg.QueryResult>((resolve, reject) => {
          query.on('end', () => resolve(query as unknown as pg.QueryResult));
          query.on('error', reject);
          client.query(query);
        });
        expect(result).toBeDefined();

        const entry = entriesBySql(pool.queryTrail(), 'via_submittable')[0];
        expect(entry).toBeDefined();
        expect(entry?.sql).toContain('SELECT 1 AS via_submittable');
        expect(entry?.kind).toBe('query');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('tags an opaque Submittable without .text as <submittable:ClassName>, never dropped', async () => {
    const pool = new PgBridgePool({ pglite, queryTrail: true });
    try {
      const client = await pool.connect();
      try {
        // A minimal custom Submittable with NO `.text` property. It delegates
        // its lifecycle to an inner pg.Query so it actually completes, but the
        // recorder — reading the OUTER object — finds no text and must record
        // a tagged entry instead of dropping the traffic or throwing.
        class OpaqueSubmittable {
          #inner = new pg.Query('SELECT 1 AS opaque');
          submit(connection: unknown): void {
            (this.#inner as unknown as { submit: (c: unknown) => void }).submit(connection);
          }
          on(event: string, listener: (...args: unknown[]) => void): this {
            (this.#inner as unknown as { on: (e: string, l: unknown) => void }).on(event, listener);
            return this;
          }
          handleRowDescription(msg: unknown): void {
            (
              this.#inner as unknown as { handleRowDescription?: (m: unknown) => void }
            ).handleRowDescription?.(msg);
          }
          handleDataRow(msg: unknown): void {
            (this.#inner as unknown as { handleDataRow?: (m: unknown) => void }).handleDataRow?.(
              msg,
            );
          }
          handleCommandComplete(msg: unknown, con: unknown): void {
            (
              this.#inner as unknown as { handleCommandComplete?: (m: unknown, c: unknown) => void }
            ).handleCommandComplete?.(msg, con);
          }
          handleReadyForQuery(con: unknown): void {
            (
              this.#inner as unknown as { handleReadyForQuery?: (c: unknown) => void }
            ).handleReadyForQuery?.(con);
          }
          handleError(err: unknown, con: unknown): void {
            (
              this.#inner as unknown as { handleError?: (e: unknown, c: unknown) => void }
            ).handleError?.(err, con);
          }
          handleEmptyQuery(con: unknown): void {
            (
              this.#inner as unknown as { handleEmptyQuery?: (c: unknown) => void }
            ).handleEmptyQuery?.(con);
          }
        }

        const opaque = new OpaqueSubmittable();
        await new Promise<void>((resolve, reject) => {
          opaque.on('end', () => resolve());
          opaque.on('error', reject);
          client.query(opaque as unknown as pg.Submittable);
        });

        const entry = entriesBySql(pool.queryTrail(), '<submittable:OpaqueSubmittable>')[0];
        expect(entry).toBeDefined();
        expect(entry?.sql).toBe('<submittable:OpaqueSubmittable>');
        expect(entry?.kind).toBe('query');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  describe('default OFF at the raw layer', () => {
    it('returns [] and stays empty without the option, and clearQueryTrail is a no-op', async () => {
      const pool = new PgBridgePool({ pglite });
      try {
        expect(pool.queryTrail()).toEqual([]);

        await pool.query('SELECT 1 AS x');
        await pool.query('SELECT $1::int AS n', [7]);

        expect(pool.queryTrail()).toEqual([]);
        // No-op — must not throw when the feature is off.
        expect(() => pool.clearQueryTrail()).not.toThrow();
        expect(pool.queryTrail()).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  });

  describe('env kill switch', () => {
    it('captures nothing when PGLITE_BRIDGE_QUERY_TRAIL=0 even with queryTrail: true', async () => {
      vi.stubEnv('PGLITE_BRIDGE_QUERY_TRAIL', '0');
      const pool = new PgBridgePool({ pglite, queryTrail: true });
      try {
        await pool.query('SELECT 1 AS x');
        await pool.query('SELECT $1::int AS n', [7]);

        // The env var only ever disables — it cannot force capture on.
        expect(pool.queryTrail()).toEqual([]);
      } finally {
        await pool.end();
      }
    });
  });

  describe('clearQueryTrail (feature on)', () => {
    it('empties the captured trail', async () => {
      const pool = new PgBridgePool({ pglite, queryTrail: true });
      try {
        await pool.query('SELECT 1 AS x');
        expect(pool.queryTrail().length).toBeGreaterThan(0);

        pool.clearQueryTrail();
        expect(pool.queryTrail()).toEqual([]);

        // Capture resumes after clear, restarting seq at 0.
        await pool.query('SELECT 2 AS y');
        const after = pool.queryTrail();
        expect(after.length).toBeGreaterThan(0);
        expect(after[0]?.seq).toBe(0);
      } finally {
        await pool.end();
      }
    });
  });
});

describe('PGliteBridge — query trail forwarding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('captures queries issued through the bridge pool into bridge.queryTrail()', async () => {
    const bridge = new PGliteBridge({ queryTrail: true });
    try {
      // Reach the bridge's internal pool the same way the bridge suite does:
      // the adapter holds the same PgBridgePool instance as `externalPool`.
      const pool = (bridge.adapter as unknown as { externalPool: PgBridgePool }).externalPool;
      await pool.query('SELECT 1 AS via_bridge');

      const trail = bridge.queryTrail();
      const entry = entriesBySql(trail, 'via_bridge')[0];
      expect(entry).toBeDefined();
      expect(entry?.status).toBe('settled');
      expect(entry?.rowCount).toBe(1);
    } finally {
      await bridge.close();
    }
  });

  it('captures Prisma adapter traffic and clearQueryTrail() clears it', async () => {
    const bridge = new PGliteBridge({ queryTrail: true });
    const prisma = new PrismaClient({ adapter: bridge.adapter });
    try {
      await prisma.$executeRawUnsafe('CREATE TABLE bridge_trail (id int)');
      await prisma.$queryRawUnsafe('SELECT 1 AS adapter_query');

      const trail = bridge.queryTrail();
      // Adapter traffic reaches the capture layer — the SELECT is present.
      expect(entriesBySql(trail, 'adapter_query').length).toBeGreaterThan(0);

      bridge.clearQueryTrail();
      expect(bridge.queryTrail()).toEqual([]);
    } finally {
      await prisma.$disconnect();
      await bridge.close();
    }
  });

  it('bridge.queryTrail() returns [] when the option is off', async () => {
    const bridge = new PGliteBridge();
    try {
      const pool = (bridge.adapter as unknown as { externalPool: PgBridgePool }).externalPool;
      await pool.query('SELECT 1 AS x');
      expect(bridge.queryTrail()).toEqual([]);
      expect(() => bridge.clearQueryTrail()).not.toThrow();
    } finally {
      await bridge.close();
    }
  });
});
