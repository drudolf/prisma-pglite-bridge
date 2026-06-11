import type {
  SqlDriverAdapter,
  SqlMigrationAwareDriverAdapterFactory,
  SqlQuery,
  SqlResultSet,
} from '@prisma/driver-adapter-utils';
import { describe, expect, it } from 'vitest';

import { rewritePg18ConstraintsSql, wrapFactoryForPg18 } from './pg18-not-null.ts';

const denylist = "contype NOT IN ('p', 'u', 'f')";
const rewrittenDenylist = "contype NOT IN ('p', 'u', 'f', 'n')";

// The real constraint introspection query from prisma-engines (constraints_query.sql).
// On PostgreSQL 18 its denylist lets NOT NULL constraint rows (contype 'n') through
// and panics the schema engine.
const engineConstraintsQuery = `SELECT
    schemainfo.nspname AS namespace,
    tableinfo.relname AS table_name,
    constr.conname AS constraint_name,
    constr.contype AS constraint_type,
    pg_get_constraintdef(constr.oid) AS constraint_definition,
    constr.condeferrable AS is_deferrable,
    constr.condeferred AS is_deferred
FROM pg_constraint constr
JOIN pg_class AS tableinfo ON tableinfo.oid = constr.conrelid
JOIN pg_namespace AS schemainfo ON schemainfo.oid = tableinfo.relnamespace
WHERE schemainfo.nspname = ANY ( $1 )
    AND contype NOT IN ('p', 'u', 'f')
ORDER BY namespace, table_name, constr.contype, constraint_name;`;

const createFakeAdapter = (adapterName: string) => {
  const queryRawCalls: SqlQuery[] = [];
  const executeRawCalls: SqlQuery[] = [];
  const cannedResult: SqlResultSet = { columnNames: [], columnTypes: [], rows: [] };
  let disposed = false;

  const adapter = {
    adapterName,
    provider: 'postgres',
    queryRaw: async (query: SqlQuery) => {
      queryRawCalls.push(query);
      return cannedResult;
    },
    executeRaw: async (query: SqlQuery) => {
      executeRawCalls.push(query);
      return 7;
    },
    dispose: async () => {
      disposed = true;
    },
  } as unknown as SqlDriverAdapter;

  return { adapter, queryRawCalls, executeRawCalls, cannedResult, isDisposed: () => disposed };
};

const createFakeFactory = () => {
  const main = createFakeAdapter('fake-pg18-main');
  const shadow = createFakeAdapter('fake-pg18-shadow');

  const factory = {
    adapterName: 'fake-pg18-factory',
    provider: 'postgres',
    connect: async () => main.adapter,
    connectToShadowDb: async () => shadow.adapter,
  } as unknown as SqlMigrationAwareDriverAdapterFactory;

  return { factory, main, shadow };
};

const createQuery = (sql: string): SqlQuery => ({
  sql,
  args: [42, 'pending'],
  argTypes: [
    { scalarType: 'int', arity: 'scalar' },
    { scalarType: 'string', arity: 'scalar' },
  ],
});

describe('rewritePg18ConstraintsSql', () => {
  it("adds 'n' to the contype denylist of the engine constraints query", () => {
    const rewritten = rewritePg18ConstraintsSql(engineConstraintsQuery);

    expect(rewritten).toBe(engineConstraintsQuery.replace(denylist, rewrittenDenylist));
    expect(rewritten).toContain(rewrittenDenylist);
  });

  it('rewrites any query that touches pg_constraint and contains the denylist', () => {
    const sql = `SELECT conname FROM pg_constraint WHERE ${denylist}`;

    expect(rewritePg18ConstraintsSql(sql)).toBe(
      `SELECT conname FROM pg_constraint WHERE ${rewrittenDenylist}`,
    );
  });

  it('returns SQL without pg_constraint or the denylist unchanged', () => {
    const sql = 'SELECT "id" FROM "User" WHERE "id" = $1';

    expect(rewritePg18ConstraintsSql(sql)).toBe(sql);
  });

  it('returns pg_constraint SQL without the denylist unchanged', () => {
    const sql = "SELECT conname FROM pg_constraint WHERE contype = 'c'";

    expect(rewritePg18ConstraintsSql(sql)).toBe(sql);
  });

  it('returns the denylist without pg_constraint unchanged', () => {
    const sql = `SELECT 1 FROM information_schema.table_constraints WHERE ${denylist}`;

    expect(rewritePg18ConstraintsSql(sql)).toBe(sql);
  });

  it('is idempotent: an already-rewritten query is returned unchanged', () => {
    const rewritten = rewritePg18ConstraintsSql(engineConstraintsQuery);

    expect(rewritePg18ConstraintsSql(rewritten)).toBe(rewritten);
  });

  it('returns an empty string unchanged', () => {
    expect(rewritePg18ConstraintsSql('')).toBe('');
  });
});

describe('wrapFactoryForPg18', () => {
  it('rewrites the engine constraints query before delegating queryRaw on connect() adapters', async () => {
    const { factory, main } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connect();

    await adapter.queryRaw(createQuery(engineConstraintsQuery));

    expect(main.queryRawCalls).toHaveLength(1);
    expect(main.queryRawCalls[0]?.sql).toContain(rewrittenDenylist);
    expect(main.queryRawCalls[0]?.sql).not.toContain(denylist);
  });

  it('returns the underlying adapter result from queryRaw', async () => {
    const { factory, main } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connect();

    const result = await adapter.queryRaw(createQuery(engineConstraintsQuery));

    expect(result).toBe(main.cannedResult);
  });

  it('passes non-matching SQL through queryRaw byte-identical', async () => {
    const { factory, main } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connect();
    const sql = 'SELECT "id" FROM "User" WHERE "id" = $1';

    await adapter.queryRaw(createQuery(sql));

    expect(main.queryRawCalls[0]?.sql).toBe(sql);
  });

  it('preserves args and argTypes when rewriting the SQL', async () => {
    const { factory, main } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connect();
    const query = createQuery(engineConstraintsQuery);

    await adapter.queryRaw(query);

    expect(main.queryRawCalls[0]?.args).toEqual(query.args);
    expect(main.queryRawCalls[0]?.argTypes).toEqual(query.argTypes);
  });

  it('rewrites the engine constraints query on connectToShadowDb() adapters', async () => {
    const { factory, shadow } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connectToShadowDb();

    await adapter.queryRaw(createQuery(engineConstraintsQuery));

    expect(shadow.queryRawCalls).toHaveLength(1);
    expect(shadow.queryRawCalls[0]?.sql).toContain(rewrittenDenylist);
    expect(shadow.queryRawCalls[0]?.sql).not.toContain(denylist);
  });

  it('delegates executeRaw to the underlying adapter with unchanged input', async () => {
    const { factory, main } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connect();

    const affected = await adapter.executeRaw(createQuery(engineConstraintsQuery));

    expect(main.executeRawCalls).toHaveLength(1);
    expect(main.executeRawCalls[0]?.sql).toBe(engineConstraintsQuery);
    expect(affected).toBe(7);
  });

  it('exposes adapterName and provider of the wrapped factory', () => {
    const { factory } = createFakeFactory();
    const wrapped = wrapFactoryForPg18(factory);

    expect(wrapped.adapterName).toBe('fake-pg18-factory');
    expect(wrapped.provider).toBe('postgres');
  });

  it('exposes adapterName and provider of the wrapped adapter', async () => {
    const { factory } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connect();

    expect(adapter.adapterName).toBe('fake-pg18-main');
    expect(adapter.provider).toBe('postgres');
  });

  it('delegates dispose() to the underlying adapter', async () => {
    const { factory, main } = createFakeFactory();
    const adapter = await wrapFactoryForPg18(factory).connect();

    await adapter.dispose();

    expect(main.isDisposed()).toBe(true);
  });

  it('delegates other factory methods with this bound to the original', async () => {
    const { factory } = createFakeFactory();
    let observed: unknown;
    (factory as unknown as Record<string, unknown>).describe = function (this: unknown) {
      observed = this;
      return 'described';
    };

    const wrapped = wrapFactoryForPg18(factory) as unknown as { describe: () => string };

    expect(wrapped.describe()).toBe('described');
    expect(observed).toBe(factory);
  });
});
