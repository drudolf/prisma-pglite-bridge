/** biome-ignore-all lint/style/noNonNullAssertion: test files only */
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeEach } from 'vitest';

const getTables = async (db: PGlite) => {
  const { rows } = await db.query<{ qualified: string }>(`
    SELECT quote_ident(schemaname) || '.' || quote_ident(tablename) AS qualified
    FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  `);

  return rows.map((r) => r.qualified);
};

const resetDb = async (db: PGlite) => {
  const tables = await getTables(db);

  if (tables.length) {
    try {
      await db.exec('SET session_replication_role = replica');
      await db.exec(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
    } finally {
      await db.exec('SET session_replication_role = DEFAULT');
    }
  }

  await db.exec('DISCARD ALL');
};

type SetupPGliteFn = (options?: { reset?: boolean }) => Promise<PGlite>;

const setupPGlite: SetupPGliteFn = async ({ reset } = {}) => {
  const pglite = new PGlite();
  await pglite.waitReady;

  if (reset) {
    beforeEach(async () => {
      await resetDb(pglite);
    });
  }

  afterAll(async () => {
    await pglite?.close();
  });

  return pglite;
};

export default setupPGlite;
