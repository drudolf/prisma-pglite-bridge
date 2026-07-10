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

/**
 * Statement-name generator: a stable `ppb_<namespace>_<n>` name per distinct
 * SQL text, so the engine parses and plans each query shape once per client
 * session and only binds/executes thereafter. Only statements matching
 * {@link CACHEABLE_SQL} are named.
 *
 * `<namespace>` is process-unique per generator instance. Each
 * `PgBridgeClient` creates its own generator, so no two clients — across
 * pools, across client generations — ever Parse the same name into the
 * shared PGlite session. Name collisions (Postgres error 42P05) are
 * impossible by construction and need no cross-client coordination.
 *
 * Bounded and frozen, not LRU — the first `limit` distinct texts keep
 * their names for the generator's lifetime; texts beyond that run
 * unnamed (correct, just uncached) so the cache cannot grow without
 * bound under pathological workloads (e.g. dynamically generated SQL).
 * `PGliteBridge` uses the default limit; it is not exposed as a public
 * knob.
 */
export const createStatementNameGenerator = (
  limit = 500,
): ((query: { sql: string }) => string | undefined) => {
  const namespace = nextNamespace();
  const names = new Map<string, string>();
  return (query: { sql: string }): string | undefined => {
    if (!CACHEABLE_SQL.test(query.sql)) return undefined;
    // Multi-statement strings are rejected by PG's Extended Query Protocol
    // Parse message — only single statements can be named. Skip naming so
    // they fall back to the simple protocol path where they work correctly.
    if (query.sql.includes(';')) return undefined;
    const cached = names.get(query.sql);
    if (cached !== undefined) return cached;
    if (names.size >= limit) return undefined;
    const name = `ppb_${namespace}_${names.size}`;
    names.set(query.sql, name);
    return name;
  };
};
