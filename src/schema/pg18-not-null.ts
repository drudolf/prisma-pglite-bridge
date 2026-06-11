/**
 * Workaround for a Prisma schema-engine panic on PostgreSQL 18.
 *
 * PostgreSQL 18 represents column NOT NULL constraints as `pg_constraint`
 * rows with `contype = 'n'` (new in PG 18). The engine's constraint
 * introspection query (sql-schema-describer constraints_query.sql) filters
 * with the denylist `contype NOT IN ('p', 'u', 'f')`, so those rows reach a
 * row-parsing path that panics ("…as char failed") and `schemaPush` never
 * settles. Verified against @prisma/schema-engine-wasm
 * 7.8.0-6.3c6e1927 — the latest published build; no upstream fix exists.
 * Remove once the pinned engine handles contype 'n'.
 *
 * Appending 'n' to the denylist makes PG 18 introspection look like PG ≤ 17,
 * where NOT NULL never appears in pg_constraint — which is also what the
 * engine expects: column nullability is read from attnotnull, not from
 * constraint rows. On PG ≤ 17 the value never occurs, so the rewrite is a
 * semantic no-op there and needs no server-version gate.
 */
import type {
  SqlDriverAdapter,
  SqlMigrationAwareDriverAdapterFactory,
  SqlQuery,
} from '@prisma/driver-adapter-utils';

const ENGINE_DENYLIST = "contype NOT IN ('p', 'u', 'f')";
const PATCHED_DENYLIST = "contype NOT IN ('p', 'u', 'f', 'n')";

export const rewritePg18ConstraintsSql = (sql: string): string => {
  if (!sql.includes('pg_constraint') || !sql.includes(ENGINE_DENYLIST)) {
    return sql;
  }
  return sql.replace(ENGINE_DENYLIST, PATCHED_DENYLIST);
};

/**
 * Proxies (rather than spreads) so class-based adapters keep working: every
 * untouched member is delegated with `this` bound to the original instance,
 * and members added in future @prisma/driver-adapter-utils versions pass
 * through without changes here.
 */
const wrapAdapter = (adapter: SqlDriverAdapter): SqlDriverAdapter =>
  new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'queryRaw') {
        return (query: SqlQuery) =>
          target.queryRaw({ ...query, sql: rewritePg18ConstraintsSql(query.sql) });
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

export const wrapFactoryForPg18 = (
  factory: SqlMigrationAwareDriverAdapterFactory,
): SqlMigrationAwareDriverAdapterFactory =>
  new Proxy(factory, {
    get(target, prop) {
      if (prop === 'connect') {
        return async () => wrapAdapter(await target.connect());
      }
      if (prop === 'connectToShadowDb') {
        return async () => wrapAdapter(await target.connectToShadowDb());
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
