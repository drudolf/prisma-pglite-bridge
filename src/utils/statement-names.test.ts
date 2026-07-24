import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createStatementNameGenerator } from './statement-names.ts';

// Names are `ppb_<namespace>_<seq>`: `<namespace>` is process-unique per
// factory call (a globalThis-keyed sequence shared across module copies),
// `<seq>` is the instance's monotonic promotion counter — it advances on
// every promotion and is never rewound, even after eviction. Tests assert
// name shape and relative sequence within one generator, never exact
// namespace ids — the sequence is shared process-wide, so ids depend on
// which tests ran before this one.
const NAME_SHAPE = /^ppb_(\d+)_(\d+)$/;

const parts = (name: string | undefined): { namespace: string; n: number } => {
  const match = NAME_SHAPE.exec(name ?? '');
  if (!match) throw new Error(`not a bridge statement name: ${String(name)}`);
  return { namespace: match[1] as string, n: Number(match[2]) };
};

describe('createStatementNameGenerator', () => {
  describe('admission gate', () => {
    it('returns undefined below the gate and names the second sighting (default minUsages 2)', () => {
      const generate = createStatementNameGenerator();

      expect(generate('SELECT 1')).toBeUndefined();

      expect(generate('SELECT 1')).toMatch(NAME_SHAPE);
    });

    it('keeps returning the promoted name on every later sighting', () => {
      const generate = createStatementNameGenerator();

      generate('SELECT 1');
      const name = generate('SELECT 1');

      expect(name).toMatch(NAME_SHAPE);
      expect(generate('SELECT 1')).toBe(name);
      expect(generate('SELECT 1')).toBe(name);
    });

    it('gates each distinct text separately', () => {
      const generate = createStatementNameGenerator();

      expect(generate('SELECT 1')).toBeUndefined();
      // A different text's sighting counts toward its own gate only.
      expect(generate('SELECT 2')).toBeUndefined();
      expect(generate('SELECT 1')).toMatch(NAME_SHAPE);
      expect(generate('SELECT 2')).toMatch(NAME_SHAPE);
    });

    it('honors a custom minUsages', () => {
      const generate = createStatementNameGenerator({ minUsages: 3 });

      expect(generate('SELECT 1')).toBeUndefined();
      expect(generate('SELECT 1')).toBeUndefined();
      expect(generate('SELECT 1')).toMatch(NAME_SHAPE);
    });

    it('drops the admission counter on promotion — an evicted text restarts from zero sightings', () => {
      const generate = createStatementNameGenerator({ capacity: 1 });

      generate('SELECT 1');
      expect(generate('SELECT 1')).toMatch(NAME_SHAPE); // promoted — counter deleted

      generate('SELECT 2');
      expect(generate('SELECT 2')).toMatch(NAME_SHAPE); // promoted — evicts SELECT 1

      // If SELECT 1's counter had survived its promotion at minUsages, this
      // first fresh sighting would re-promote immediately. It must pass the
      // full gate again instead.
      expect(generate('SELECT 1')).toBeUndefined();
      expect(generate('SELECT 1')).toMatch(NAME_SHAPE);
    });
  });

  describe('monotonic promotion counter', () => {
    it('numbers promotions in promotion order within one namespace', () => {
      const generate = createStatementNameGenerator({ minUsages: 1 });

      const first = parts(generate('SELECT 1'));
      const second = parts(generate('SELECT 2'));
      const third = parts(generate('SELECT 3'));

      // One namespace per generator instance…
      expect(second.namespace).toBe(first.namespace);
      expect(third.namespace).toBe(first.namespace);
      // …with the promotion counter advancing in promotion order.
      expect(second.n).toBe(first.n + 1);
      expect(third.n).toBe(first.n + 2);

      // Interleaved hits do not disturb the mapping.
      expect(parts(generate('SELECT 2'))).toEqual(second);
      expect(parts(generate('SELECT 1'))).toEqual(first);
    });

    it('never reuses a name — an evicted text re-promotes under a fresh one', () => {
      const generate = createStatementNameGenerator({ capacity: 1, minUsages: 1 });

      const first = generate('SELECT 1');
      const second = generate('SELECT 2'); // evicts SELECT 1
      const rePromoted = generate('SELECT 1'); // evicts SELECT 2

      expect(rePromoted).toMatch(NAME_SHAPE);
      expect(rePromoted).not.toBe(first);
      // The counter is monotonic — it never rewinds into a freed slot, so a
      // delayed or lost server-side Close can never hit reused identity.
      expect(parts(rePromoted).n).toBe(parts(first).n + 2);
      expect(new Set([first, second, rePromoted]).size).toBe(3);
    });

    it('two factory instances produce disjoint name sets for identical SQL', () => {
      const a = createStatementNameGenerator({ minUsages: 1 });
      const b = createStatementNameGenerator({ minUsages: 1 });

      const texts = ['SELECT 1', 'SELECT 2', 'SELECT 3'];
      const aNames = texts.map((sql) => a(sql));
      const bNames = texts.map((sql) => b(sql));

      for (const name of [...aNames, ...bNames]) expect(name).toMatch(NAME_SHAPE);
      // Same SQL, same promotion position — never the same name: the
      // namespaces differ, so cross-client 42P05 collisions in the shared
      // PGlite session are structurally impossible.
      expect(parts(aNames[0]).namespace).not.toBe(parts(bNames[0]).namespace);
      const overlap = aNames.filter((name) => bNames.includes(name));
      expect(overlap).toEqual([]);
    });
  });

  describe('LRU eviction', () => {
    it('evicts the least-recently-used name at capacity and fires onEvict synchronously exactly once', () => {
      const evicted: string[] = [];
      const generate = createStatementNameGenerator({
        capacity: 2,
        minUsages: 1,
        onEvict: (name) => evicted.push(name),
      });

      const a = generate('SELECT 1');
      const b = generate('SELECT 2');
      expect(evicted).toEqual([]);

      generate('SELECT 3');

      // generate() is synchronous, so the callback must already have run
      // when it returned — no await, no microtask in between.
      expect(evicted).toEqual([a]);

      // Hits on the survivors never re-fire the eviction.
      expect(generate('SELECT 2')).toBe(b);
      expect(generate('SELECT 3')).toMatch(NAME_SHAPE);
      expect(evicted).toEqual([a]);
    });

    it('a hit refreshes recency — the untouched entry is evicted instead', () => {
      const evicted: string[] = [];
      const generate = createStatementNameGenerator({
        capacity: 2,
        minUsages: 1,
        onEvict: (name) => evicted.push(name),
      });

      const a = generate('SELECT 1');
      const b = generate('SELECT 2');
      generate('SELECT 1'); // refresh — SELECT 2 is now the LRU entry

      generate('SELECT 3');

      expect(evicted).toEqual([b]);
      expect(generate('SELECT 1')).toBe(a); // survived the eviction
    });

    it('honors a custom capacity per instance — a sibling generator is unaffected', () => {
      const evictedA: string[] = [];
      const a = createStatementNameGenerator({
        capacity: 1,
        minUsages: 1,
        onEvict: (name) => evictedA.push(name),
      });
      const evictedB: string[] = [];
      const b = createStatementNameGenerator({
        capacity: 1,
        minUsages: 1,
        onEvict: (name) => evictedB.push(name),
      });

      const a1 = a('SELECT 1');
      const b1 = b('SELECT 1');
      a('SELECT 2'); // evicts a's entry only

      expect(evictedA).toEqual([a1]);
      expect(evictedB).toEqual([]);
      expect(b('SELECT 1')).toBe(b1);
    });

    it('defaults to capacity 500 — the 501st promotion evicts the oldest instead of freezing', () => {
      const evicted: string[] = [];
      const generate = createStatementNameGenerator({
        minUsages: 1,
        onEvict: (name) => evicted.push(name),
      });

      const names = Array.from({ length: 500 }, (_, i) => generate(`SELECT ${i}`));
      expect(names.every((name) => typeof name === 'string')).toBe(true);
      expect(new Set(names).size).toBe(500);
      expect(evicted).toEqual([]);

      // Past capacity the generator keeps naming — LRU eviction replaced the
      // frozen cap that returned undefined here.
      const overflow = generate('SELECT 500');
      expect(overflow).toMatch(NAME_SHAPE);
      expect(evicted).toEqual([names[0]]);
    });
  });

  describe('admission-counter rotation', () => {
    it('promotes nothing when the working set is wider than capacity', () => {
      const evicted: string[] = [];
      const generate = createStatementNameGenerator({
        capacity: 2,
        onEvict: (name) => evicted.push(name),
      });

      // Round-robin over 3 texts with capacity 2: every admission counter is
      // displaced before its text recurs, so no sighting ever reaches the
      // gate — the cache correctly refuses to churn under uniform thrash.
      for (let round = 0; round < 3; round++) {
        for (const sql of ['SELECT 1', 'SELECT 2', 'SELECT 3']) {
          expect(generate(sql)).toBeUndefined();
        }
      }
      expect(evicted).toEqual([]);
    });

    it('a displaced counter restarts — the text needs a full round of fresh sightings to promote', () => {
      const generate = createStatementNameGenerator({ capacity: 2 });

      expect(generate('SELECT 1')).toBeUndefined(); // counters: 1
      expect(generate('SELECT 2')).toBeUndefined(); // counters: 1, 2
      expect(generate('SELECT 3')).toBeUndefined(); // displaces SELECT 1's counter
      // Without the displacement this would be SELECT 1's second sighting
      // and promote; the counter restarted instead.
      expect(generate('SELECT 1')).toBeUndefined();
      expect(generate('SELECT 1')).toMatch(NAME_SHAPE);
    });

    it("a sighting refreshes an admission counter's recency", () => {
      const generate = createStatementNameGenerator({ capacity: 2, minUsages: 3 });

      expect(generate('SELECT 1')).toBeUndefined(); // 1: one sighting
      expect(generate('SELECT 2')).toBeUndefined(); // 2: one sighting
      expect(generate('SELECT 1')).toBeUndefined(); // 1: two sightings, refreshed
      expect(generate('SELECT 3')).toBeUndefined(); // displaces SELECT 2 (LRU), not 1
      // SELECT 1's counter survived the displacement — the third sighting
      // reaches the gate.
      expect(generate('SELECT 1')).toMatch(NAME_SHAPE);
    });
  });

  describe('namespace sequence self-heal on poisoned globalThis slot', () => {
    const NAMESPACE_SEQ = Symbol.for('prisma-pglite-bridge.stmt-namespace-seq');
    // Cast so TypeScript accepts the symbol-keyed write.
    const holder = globalThis as unknown as Record<symbol, unknown>;

    let savedSlot: unknown;
    beforeEach(() => {
      savedSlot = holder[NAMESPACE_SEQ];
    });
    afterEach(() => {
      holder[NAMESPACE_SEQ] = savedSlot;
    });

    // Helper: drive a cacheable SQL text to promotion (default minUsages = 2).
    const promoteOne = (sql: string): string => {
      const gen = createStatementNameGenerator();
      gen(sql); // first sighting — below gate
      return gen(sql) as string; // second sighting — promoted
    };

    it.each([
      ['string poison', 'evil' as unknown as number],
      ['negative integer', -5],
      ['fractional number', 2.5],
      ['NaN', Number.NaN],
    ])(
      'treats poisoned slot (%s) as 0 — produces ppb_0_0 and heals the slot to 1',
      (_label, poison) => {
        holder[NAMESPACE_SEQ] = poison;

        const name = promoteOne('select 1');

        // Self-heal: namespace must be 0 regardless of the poison value,
        // and the slot must advance to 1 after the generator is created.
        expect(name).toBe('ppb_0_0');
        expect(holder[NAMESPACE_SEQ]).toBe(1);
      },
    );

    it('valid slot value increments normally — slot 7 produces ppb_7_0 and slot becomes 8', () => {
      holder[NAMESPACE_SEQ] = 7;

      const name = promoteOne('select 1');

      expect(name).toBe('ppb_7_0');
      expect(holder[NAMESPACE_SEQ]).toBe(8);
    });
  });

  describe('cacheability guard', () => {
    it.each([
      'CREATE TABLE "X" (id int)',
      'ALTER TABLE "X" ADD COLUMN y int',
      'DROP TABLE "X"',
      'TRUNCATE "X"',
      `SET application_name = 'y'`,
      'BEGIN',
      'COMMIT',
      'ROLLBACK',
      'DEALLOCATE ALL',
    ])('never names non-cacheable statement: %s', (sql) => {
      const generate = createStatementNameGenerator();

      // Non-DML never enters the admission pipeline — repeat sightings stay
      // unnamed forever; they never accumulate toward the gate.
      expect(generate(sql)).toBeUndefined();
      expect(generate(sql)).toBeUndefined();
      expect(generate(sql)).toBeUndefined();
    });

    it('non-cacheable statements consume no promotion numbers', () => {
      const generate = createStatementNameGenerator({ minUsages: 1 });

      const first = parts(generate('SELECT 1'));
      generate('CREATE TABLE "X" (id int)');
      generate('CREATE TABLE "X" (id int)');
      const second = parts(generate('SELECT 2'));

      // The DDL in between advanced neither the admission counters nor the
      // promotion sequence.
      expect(second.n).toBe(first.n + 1);
    });

    it('names statements regardless of keyword case and leading whitespace', () => {
      const generate = createStatementNameGenerator({ minUsages: 1 });

      expect(generate('  select 1')).toMatch(NAME_SHAPE);
    });

    it.each([
      'WITH t AS (SELECT 1) SELECT * FROM t',
      'MERGE INTO x USING y ON true WHEN MATCHED THEN DO NOTHING',
      'VALUES (1)',
      'INSERT INTO "X" (id) VALUES (1)',
      'UPDATE "X" SET id = 2 WHERE id = 1',
      'DELETE FROM "X" WHERE id = 1',
    ])('names cacheable statement: %s', (sql) => {
      const generate = createStatementNameGenerator({ minUsages: 1 });

      expect(generate(sql)).toMatch(NAME_SHAPE);
    });

    it('requires the leading keyword to be a whole word', () => {
      const generate = createStatementNameGenerator({ minUsages: 1 });

      expect(generate('selectx')).toBeUndefined();
    });

    it('returns undefined for multi-statement strings (semicolon guard)', () => {
      const generate = createStatementNameGenerator({ minUsages: 1 });

      expect(generate('INSERT INTO x VALUES (1); INSERT INTO y VALUES (2)')).toBeUndefined();
      // Repeat sightings never accumulate toward the gate either.
      expect(generate('INSERT INTO x VALUES (1); INSERT INTO y VALUES (2)')).toBeUndefined();
      // Single statement without semicolon still gets named.
      expect(generate('INSERT INTO x VALUES (1)')).toMatch(NAME_SHAPE);
    });
  });
});
