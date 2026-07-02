/**
 * Statement-name generator for `@prisma/adapter-pg`'s
 * `statementNameGenerator` option: a stable `ppb_<n>` name per distinct
 * SQL text, so the engine parses and plans each query shape once per
 * session and only binds/executes thereafter.
 *
 * Bounded — beyond `limit` distinct texts, new queries run unnamed so the
 * name cache cannot grow without bound under pathological workloads
 * (e.g. dynamically generated SQL). Texts cached before the limit keep
 * their names.
 */
export const createStatementNameGenerator = (
  limit = 500,
): ((query: { sql: string }) => string | undefined) => {
  const names = new Map<string, string>();
  return (query) => {
    const cached = names.get(query.sql);
    if (cached !== undefined) return cached;
    if (names.size >= limit) return undefined;
    const name = `ppb_${names.size}`;
    names.set(query.sql, name);
    return name;
  };
};
