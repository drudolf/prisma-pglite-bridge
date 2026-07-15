/**
 * Statement-name cache tradeoff benchmark: gated LRU (shipped) vs frozen
 * cap (pre-gate policy) vs pure LRU (parked on the LRU branch, 2026-07-02).
 *
 * Port of the parked branch's benchmark to the per-client architecture,
 * with its Prisma section replaced by the measurement that decided the
 * revival: WIRE-LEVEL EVICTION COST. The parked branch's blocking design
 * finding was "LRU adds a serialized DEALLOCATE round-trip per miss —
 * under thrash that is pure overhead". The modern duplex offers a
 * cheaper eviction: a protocol `Close(statement)` message piggybacked
 * onto the next EQP batch. Section D measures all the primitive costs
 * so the tradeoff can be computed instead of argued. That evidence (plus
 * the 2026-07-11 driver survey) shipped the gated LRU.
 *
 * Usage: pnpm bench:statement-cache
 */
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGliteDuplex } from '../src/duplex/index.ts';
import { createStatementNameGenerator } from '../src/utils/statement-names.ts';

const now = () => performance.now();
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
};

type Gen = (q: { sql: string }) => string | undefined;

// LRU generator lifted from the parked draft: hits reorder to MRU,
// inserts past capacity evict the LRU entry (reported via onEvict — the
// caller deallocates/closes it). Names are monotonic and never reused,
// so a failed eviction can only leak a statement, never misexecute.
const createLruGenerator = (capacity = 500, onEvict?: (name: string) => void): Gen => {
  const names = new Map<string, string>();
  let counter = 0;
  return (q) => {
    const cached = names.get(q.sql);
    if (cached !== undefined) {
      names.delete(q.sql);
      names.set(q.sql, cached);
      return cached;
    }
    if (names.size >= capacity) {
      const lruSql = names.keys().next().value as string;
      const lruName = names.get(lruSql) as string;
      names.delete(lruSql);
      try {
        onEvict?.(lruName);
      } catch {
        // Eviction reporting must never break the query path.
      }
    }
    const name = `ppb_lru_${counter++}`;
    names.set(q.sql, name);
    return name;
  };
};

// Stateless hash (Prisma's recommended shape), for reference.
const hashGen: Gen = (q) =>
  `ppb_${createHash('sha1').update(q.sql).digest('base64url').slice(0, 16)}`;

// ─── B. generator warm per-call cost ─────────────────────────────────────────

console.log('\n=== B. generator call cost (warm: all shapes cached) ===');
const shapes = Array.from({ length: 50 }, (_, i) => ({
  sql: `SELECT * FROM "Job" WHERE "priority" = $1 AND "id" > '${i}' ORDER BY "id" LIMIT 100`,
}));
const M = 500_000;
for (const [label, gen] of [
  ['gated LRU (shipped)', createStatementNameGenerator() as Gen],
  ['pure LRU (delete+set)', createLruGenerator()],
  ['hash (sha1)', hashGen],
] as [string, Gen][]) {
  for (let i = 0; i < 20_000; i++) gen(shapes[i % shapes.length] as { sql: string });
  const s = now();
  for (let i = 0; i < M; i++) gen(shapes[i % shapes.length] as { sql: string });
  const ns = ((now() - s) / M) * 1e6;
  console.log(`${label.padEnd(24)} ${ns.toFixed(1)} ns/call`);
}

// ─── C. parse rate under access patterns (generator-level, deterministic) ────

const countFrozen = (seq: string[], cap: number) => {
  const names = new Map<string, number>();
  let miss = 0;
  for (const sql of seq) {
    if (names.has(sql)) continue;
    miss++;
    if (names.size < cap) names.set(sql, names.size);
  }
  return miss / seq.length;
};
const countLru = (seq: string[], cap: number) => {
  const names = new Map<string, number>();
  let miss = 0;
  let evictions = 0;
  for (const sql of seq) {
    const v = names.get(sql);
    if (v !== undefined) {
      names.delete(sql);
      names.set(sql, v);
      continue;
    }
    miss++;
    if (names.size >= cap) {
      names.delete(names.keys().next().value as string);
      evictions++;
    }
    names.set(sql, miss);
  }
  return { missRate: miss / seq.length, evictions };
};
// The shipped policy: usage-gated admission (K sightings before naming,
// counters in an LRU map capped at capacity) in front of an LRU name cache.
const countGated = (seq: string[], cap: number, minUsages = 2) => {
  const counts = new Map<string, number>();
  const names = new Map<string, number>();
  let miss = 0;
  let evictions = 0;
  for (const sql of seq) {
    const v = names.get(sql);
    if (v !== undefined) {
      names.delete(sql);
      names.set(sql, v);
      continue;
    }
    miss++;
    const count = (counts.get(sql) ?? 0) + 1;
    counts.delete(sql);
    if (count < minUsages) {
      counts.set(sql, count);
      if (counts.size > cap) counts.delete(counts.keys().next().value as string);
      continue;
    }
    if (names.size >= cap) {
      names.delete(names.keys().next().value as string);
      evictions++;
    }
    names.set(sql, miss);
  }
  return { missRate: miss / seq.length, evictions };
};

const lcg = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const shapeSql = (i: number) => `Q${i}`;
const CAP = 64;

// hot-first: hot set (fits cap) seen first, then 80% hot / 20% fresh cold.
const hotFirst = (() => {
  const rnd = lcg(1);
  const hot = CAP - 16;
  const seq: string[] = [];
  for (let i = 0; i < hot; i++) seq.push(shapeSql(i));
  let cold = hot;
  for (let i = 0; i < 8000; i++) {
    seq.push(rnd() < 0.8 ? shapeSql(Math.floor(rnd() * hot)) : shapeSql(cold++));
  }
  return seq;
})();

// phase-shift: cap*2 cold shapes fill the cache first, THEN a hot set repeats.
const phaseShift = (() => {
  const seq: string[] = [];
  for (let i = 0; i < CAP * 2; i++) seq.push(shapeSql(1000 + i));
  const hot = CAP - 16;
  for (let r = 0; r < 200; r++) for (let i = 0; i < hot; i++) seq.push(shapeSql(i));
  return seq;
})();

// thrash: working set 3x the cap, uniform round-robin (no locality).
const thrash = (() => {
  const seq: string[] = [];
  const total = CAP * 3;
  for (let i = 0; i < 8000; i++) seq.push(shapeSql(i % total));
  return seq;
})();

console.log(`\n=== C. parse rate (lower is better), capacity ${CAP} ===`);
console.log(
  `${'pattern'.padEnd(28)}${'frozen cap'.padStart(14)}${'pure LRU'.padStart(10)}${'gated LRU'.padStart(11)}${'LRU/gated evict'.padStart(18)}`,
);
const patternRows: Array<[string, number, number, number]> = [];
for (const [label, seq] of [
  ['hot-set-first (locality)', hotFirst],
  ['phase-shift (set moves)', phaseShift],
  ['thrash (no locality, 3x cap)', thrash],
] as [string, string[]][]) {
  const f = countFrozen(seq, CAP);
  const l = countLru(seq, CAP);
  const g = countGated(seq, CAP);
  patternRows.push([label, f, l.missRate, l.evictions / seq.length]);
  console.log(
    `${label.padEnd(28)}${`${(f * 100).toFixed(1)}%`.padStart(14)}${`${(l.missRate * 100).toFixed(1)}%`.padStart(10)}${`${(g.missRate * 100).toFixed(1)}%`.padStart(11)}${`${l.evictions}/${g.evictions}`.padStart(18)}`,
  );
}

// ─── D. wire-level primitive costs (bare duplex, real PGlite) ────────────────

// The costs the tradeoff is made of, measured as full round-trips through
// the duplex: a warm named execution (parse-skipped), an unnamed
// execution (the "miss" everyone pays), a DEALLOCATE query (the parked
// draft's eviction), a standalone protocol Close(statement)+Sync, and —
// the modern option — a Close PIGGYBACKED onto an unnamed execution's
// batch, whose marginal cost over the plain unnamed execution is the true
// price of LRU eviction in the revived design.

const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const msg = (type: string, body: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(4 + body.length);
  return Buffer.concat([Buffer.from(type, 'ascii'), len, body]);
};
const parseMsg = (name: string, sql: string) =>
  msg('P', Buffer.concat([cstr(name), cstr(sql), Buffer.from([0, 0])]));
const bindMsg = (name: string) =>
  msg('B', Buffer.concat([cstr(''), cstr(name), Buffer.from([0, 0, 0, 0, 0, 0])]));
const executeMsg = () => msg('E', Buffer.concat([cstr(''), Buffer.from([0, 0, 0, 0])]));
const syncMsg = () => msg('S', Buffer.alloc(0));
const closeMsg = (name: string) => msg('C', Buffer.concat([Buffer.from('S'), cstr(name)]));
const startupBytes = (): Buffer => {
  const params = Buffer.from('user\0postgres\0database\0postgres\0\0');
  const buf = Buffer.alloc(8 + params.length);
  buf.writeUInt32BE(8 + params.length, 0);
  buf.writeUInt32BE(0x00030000, 4);
  params.copy(buf, 8);
  return buf;
};

const SQL = 'SELECT n FROM sc_bench WHERE n < 50 ORDER BY n';

const pglite = new PGlite();
await pglite.waitReady;
await pglite.exec(
  'CREATE TABLE sc_bench AS SELECT n FROM generate_series(1, 200) AS n; ANALYZE sc_bench',
);
const duplex = new PGliteDuplex(pglite);
duplex.on('error', () => {});

// Leftover-proof response accounting: ONE persistent data listener counts
// ReadyForQuery frames across chunk boundaries and resolves waiters in
// FIFO order — a batch whose response carries stray frames (or a bug that
// produces TWO RFQs) can never poison the next measurement's timing.
// Every batch below ends in exactly one Sync → exactly one RFQ.
const rfqWaiters: Array<() => void> = [];
let frameRemainder = Buffer.alloc(0);
duplex.on('data', (chunk: Buffer) => {
  const data = frameRemainder.length > 0 ? Buffer.concat([frameRemainder, chunk]) : chunk;
  let p = 0;
  while (p + 5 <= data.length) {
    const len = data.readUInt32BE(p + 1);
    if (p + 1 + len > data.length) break; // frame spans chunks
    if (data[p] === 0x5a && len === 5) rfqWaiters.shift()?.();
    p += 1 + len;
  }
  frameRemainder = Buffer.from(data.subarray(p));
});
const roundTrip = (bytes: Buffer): Promise<void> =>
  new Promise((resolve, reject) => {
    rfqWaiters.push(resolve);
    duplex.write(bytes, (err) => {
      if (err) reject(err);
    });
  });

await roundTrip(startupBytes());

const D_N = 600;
const D_WARM = 60;
const measure = async (label: string, makeBytes: (i: number) => Buffer): Promise<number> => {
  for (let i = 0; i < D_WARM; i++) await roundTrip(makeBytes(i));
  const t: number[] = [];
  for (let i = D_WARM; i < D_WARM + D_N; i++) {
    const bytes = makeBytes(i);
    const s = now();
    await roundTrip(bytes);
    t.push(now() - s);
  }
  const p50 = pct(t, 50);
  console.log(
    `${label.padEnd(44)} p50 ${(p50 * 1000).toFixed(1)}µs  p90 ${(pct(t, 90) * 1000).toFixed(1)}µs`,
  );
  return p50;
};

console.log(`\n=== D. wire-level primitive costs (n=${D_N}) ===`);

// Victim statements for the eviction measurements, prepared OUTSIDE any
// timed window: every Close/DEALLOCATE below targets a name that really
// exists, and preparation cost never contaminates eviction cost.
const TOTAL = D_WARM + D_N;
const prepareVictims = async (prefix: string): Promise<void> => {
  for (let i = 0; i < TOTAL; i++) {
    await roundTrip(Buffer.concat([parseMsg(`${prefix}${i}`, SQL), syncMsg()]));
  }
};

// Warm named execution: statement prepared once, then bind/execute/sync.
await roundTrip(Buffer.concat([parseMsg('sc_warm', SQL), syncMsg()]));
const warmNamed = await measure('named warm (Bind+Execute+Sync)', () =>
  Buffer.concat([bindMsg('sc_warm'), executeMsg(), syncMsg()]),
);

// Unnamed execution: full Parse+Bind+Execute+Sync every time — the miss
// cost, identical for frozen-past-cap recurrences and LRU re-encounters.
const unnamed = await measure('unnamed miss (Parse+Bind+Execute+Sync)', () =>
  Buffer.concat([parseMsg('', SQL), bindMsg(''), executeMsg(), syncMsg()]),
);

// DEALLOCATE as a standalone query round trip — the parked draft's
// eviction: one extra serialized round trip per eviction.
await prepareVictims('sc_d_');
const evictDealloc = await measure('DEALLOCATE query round trip (draft eviction)', (i) =>
  msg('Q', cstr(`DEALLOCATE "sc_d_${i}"`)),
);

// Protocol Close(statement)+Sync as its own round trip.
await prepareVictims('sc_c_');
const closeStandalone = await measure('Close(S)+Sync round trip', (i) =>
  Buffer.concat([closeMsg(`sc_c_${i}`), syncMsg()]),
);

// Close piggybacked onto an unnamed execution's batch — the revived
// design's eviction. Marginal cost = this minus the unnamed miss.
await prepareVictims('sc_p_');
const piggyback = await measure('unnamed miss + piggybacked Close(S)', (i) =>
  Buffer.concat([closeMsg(`sc_p_${i}`), parseMsg('', SQL), bindMsg(''), executeMsg(), syncMsg()]),
);

console.log('\n=== verdict inputs ===');
const parseSkipWin = unnamed - warmNamed;
const evictClose = piggyback - unnamed;
console.log(`parse-skip win per hit             ${(parseSkipWin * 1000).toFixed(1)}µs`);
console.log(
  `eviction: DEALLOCATE round trip    ${(evictDealloc * 1000).toFixed(1)}µs (draft design)`,
);
console.log(
  `eviction: Close+Sync round trip    ${(closeStandalone * 1000).toFixed(1)}µs (standalone)`,
);
console.log(
  `eviction: piggybacked Close        ${(evictClose * 1000).toFixed(1)}µs marginal (revived design)`,
);
console.log('\nper-query expected cost = missRate × unnamedMiss + hitRate × warmNamed');
console.log(
  '                        + evictionRate × evictionCost   (vs frozen: no eviction term)',
);
for (const [label, frozenMiss, lruMiss, evictRate] of patternRows) {
  const frozenCost = frozenMiss * unnamed + (1 - frozenMiss) * warmNamed;
  const lruClose = lruMiss * unnamed + (1 - lruMiss) * warmNamed + evictRate * evictClose;
  const lruDealloc = lruMiss * unnamed + (1 - lruMiss) * warmNamed + evictRate * evictDealloc;
  console.log(
    `${label.padEnd(28)} frozen ${(frozenCost * 1000).toFixed(0)}µs   LRU+Close ${(lruClose * 1000).toFixed(0)}µs   LRU+DEALLOCATE ${(lruDealloc * 1000).toFixed(0)}µs`,
  );
}

duplex.destroy();
await duplex.onClose;
if (!pglite.closed) await pglite.close();
