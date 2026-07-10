/** Statement shapes that produce a reusable plan. DDL, `SET`, and
 *  transaction control run unnamed — `pushSchema` issues DDL through the
 *  adapter, and naming those one-shot texts would waste cache slots and
 *  session memory on statements that never execute twice. */
const CACHEABLE_SQL = /^\s*(?:select|insert|update|delete|with|merge|values)\b/i;

/**
 * Statement-name generator for `@prisma/adapter-pg`'s
 * `statementNameGenerator` option: a stable `ppb_<n>` name per distinct
 * SQL text, so the engine parses and plans each query shape once per
 * session and only binds/executes thereafter. Only statements matching
 * {@link CACHEABLE_SQL} are named.
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
  const names = new Map<string, string>();
  return (query) => {
    if (!CACHEABLE_SQL.test(query.sql)) return undefined;
    const cached = names.get(query.sql);
    if (cached !== undefined) return cached;
    if (names.size >= limit) return undefined;
    const name = `ppb_${names.size}`;
    names.set(query.sql, name);
    return name;
  };
};
