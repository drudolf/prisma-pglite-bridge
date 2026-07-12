/** Statement shapes that produce a reusable plan. DDL, `SET`, and
 *  transaction control run unnamed — `pushSchema` issues DDL through the
 *  adapter, and naming those one-shot texts would waste cache slots and
 *  session memory on statements that never execute twice. */
const CACHEABLE_SQL = /^\s*(?:select|insert|update|delete|with|merge|values)\b/i;

/** Process-wide namespace sequence for generator instances. Lives on
 *  `globalThis` because duplicate copies of this module (dual-package
 *  installs, vitest per-worker module registries) would each restart a
 *  module-level counter at 0 and hand out colliding namespaces. */
const NAMESPACE_SEQ: unique symbol = Symbol.for('prisma-pglite-bridge.stmt-namespace-seq');

const nextNamespace = (): number => {
  const holder = globalThis as { [NAMESPACE_SEQ]?: number };
  const id = holder[NAMESPACE_SEQ] ?? 0;
  holder[NAMESPACE_SEQ] = id + 1;
  return id;
};

export interface StatementNameGeneratorOptions {
  /** Maximum named statements held at once; also caps the admission-counter
   *  map. Default 500. */
  capacity?: number;
  /** Sightings of a SQL text before it earns a name. Below the gate the
   *  query runs unnamed (re-parsed each execution). Default 2 — one-shot
   *  shapes never enter the cache, so they cannot displace hot entries. */
  minUsages?: number;
  /** Fires synchronously when a promotion at capacity evicts the
   *  least-recently-used name. The listener owns freeing the server-side
   *  statement (`PgBridgeClient` queues a wire `Close('S', name)`). */
  onEvict?: (name: string) => void;
}

/**
 * Statement-name generator: a stable `ppb_<namespace>_<seq>` name per
 * promoted SQL text, so the engine parses and plans each query shape once
 * per client session and only binds/executes thereafter. Only statements
 * matching {@link CACHEABLE_SQL} are ever counted or named.
 *
 * `<namespace>` is process-unique per generator instance. Each
 * `PgBridgeClient` creates its own generator, so no two clients — across
 * pools, across client generations — ever Parse the same name into the
 * shared PGlite session. Name collisions (Postgres error 42P05) are
 * impossible by construction and need no cross-client coordination.
 *
 * Admission is usage-gated (the psycopg3/pgJDBC pattern): a text is named
 * on its `minUsages`-th sighting, tracked in an LRU-ordered counter map
 * capped at `capacity` — under a working set wider than the cap, counters
 * are displaced before recurrence and nothing promotes, so the cache
 * refuses to churn instead of thrashing.
 *
 * Named entries are LRU-ordered; a promotion at capacity evicts the
 * least-recently-used name via `onEvict`. `<seq>` is a monotonic promotion
 * counter, never `names.size`: names are never reused, even after eviction,
 * so a `Close` that is delayed or lost can never make a name identify
 * different SQL (42P05/26000 unreachable) — it only orphans one
 * session-side statement. Wrap is theoretical (2^53 promotions).
 */
export const createStatementNameGenerator = (
  options: StatementNameGeneratorOptions = {},
): ((query: { sql: string }) => string | undefined) => {
  const { capacity = 500, minUsages = 2, onEvict } = options;
  const namespace = nextNamespace();
  const counts = new Map<string, number>();
  const names = new Map<string, string>();
  let seq = 0;
  return (query: { sql: string }): string | undefined => {
    if (!CACHEABLE_SQL.test(query.sql)) return undefined;
    // Multi-statement strings are rejected by PG's Extended Query Protocol
    // Parse message — only single statements can be named. Skip naming so
    // they fall back to the simple protocol path where they work correctly.
    if (query.sql.includes(';')) return undefined;
    const cached = names.get(query.sql);
    if (cached !== undefined) {
      // Delete+set keeps insertion order as recency order — the Map's first
      // key is always the LRU candidate.
      names.delete(query.sql);
      names.set(query.sql, cached);
      return cached;
    }
    const count = (counts.get(query.sql) ?? 0) + 1;
    counts.delete(query.sql);
    if (count < minUsages) {
      counts.set(query.sql, count);
      if (counts.size > capacity) {
        for (const oldest of counts.keys()) {
          counts.delete(oldest);
          break;
        }
      }
      return undefined;
    }
    if (names.size >= capacity) {
      for (const [lruSql, lruName] of names) {
        names.delete(lruSql);
        onEvict?.(lruName);
        break;
      }
    }
    const name = `ppb_${namespace}_${seq}`;
    seq += 1;
    names.set(query.sql, name);
    return name;
  };
};
