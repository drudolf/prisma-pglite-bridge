import type { PGlite } from '@electric-sql/pglite';

export const SENTINEL_SCHEMA = '_pglite_bridge';
export const SENTINEL_TABLE = '__initialized';
export const SENTINEL_MARKER = 'prisma-pglite-bridge:init:v1';

export interface SentinelRow {
  marker: string;
  version: number;
}

const escapeLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

export const SENTINAL_COLLISON_ERROR_MESSAGE: string =
  `"${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" exists but is not owned by prisma-pglite-bridge. ` +
  `The "${SENTINEL_SCHEMA}" schema is reserved for library metadata.`;

export const isValidSentinelRow = (rows: Array<SentinelRow>): boolean =>
  rows.length === 1 && rows[0]?.marker === SENTINEL_MARKER && rows[0]?.version === 1;

export const SENTINEL_STATEMENTS: string = [
  `CREATE SCHEMA IF NOT EXISTS "${SENTINEL_SCHEMA}"`,
  `CREATE TABLE IF NOT EXISTS "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL)`,
  `INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES (${escapeLiteral(SENTINEL_MARKER)}, 1) ON CONFLICT (marker) DO NOTHING`,
].join(';\n');

const querySentinelRows = async (pglite: PGlite): Promise<Array<SentinelRow>> => {
  const { rows } = await pglite.query<SentinelRow>(
    `SELECT marker, version FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}"`,
  );
  return rows;
};

export const querySentinel = async (pglite: PGlite): Promise<SentinelRow | undefined> => {
  const rows = await querySentinelRows(pglite);
  return rows[0];
};

export const writeSentinel = async (pglite: PGlite): Promise<void> => {
  try {
    await pglite.exec(`BEGIN;\n${SENTINEL_STATEMENTS}`);

    const rows = await querySentinelRows(pglite);
    if (!isValidSentinelRow(rows)) throw new Error(SENTINAL_COLLISON_ERROR_MESSAGE);
    await pglite.exec('COMMIT');
  } catch (error) {
    await pglite.exec('ROLLBACK').catch(() => {});
    throw error instanceof Error && error.message === SENTINAL_COLLISON_ERROR_MESSAGE
      ? error
      : new Error(SENTINAL_COLLISON_ERROR_MESSAGE, { cause: error });
  }
};

export const isDatabaseInitialized = async (pglite: PGlite): Promise<boolean> => {
  const { rows: tableExists } = await pglite.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_tables
         WHERE schemaname = '${SENTINEL_SCHEMA}' AND tablename = '${SENTINEL_TABLE}'
     ) AS found`,
  );

  if (tableExists[0]?.found) {
    try {
      const rows = await querySentinelRows(pglite);
      if (isValidSentinelRow(rows)) return true;
    } catch {
      // Table has incompatible columns — fall through to collision error
    }

    throw new Error(SENTINAL_COLLISON_ERROR_MESSAGE);
  }

  const { rows: schemaExists } = await pglite.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_namespace WHERE nspname = '${SENTINEL_SCHEMA}'
     ) AS found`,
  );
  if (schemaExists[0]?.found) {
    throw new Error(
      `Schema "${SENTINEL_SCHEMA}" exists but is not owned by prisma-pglite-bridge. ` +
        `The "${SENTINEL_SCHEMA}" schema is reserved for library metadata.`,
    );
  }

  const { rows: legacy } = await pglite.query<{ initialized: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
         WHERE n.nspname = 'public'
       UNION ALL
       SELECT 1 FROM pg_type t JOIN pg_namespace n ON t.typnamespace = n.oid
         WHERE n.nspname = 'public' AND t.typtype NOT IN ('b', 'p')
       UNION ALL
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
         WHERE n.nspname = 'public'
       UNION ALL
       SELECT 1 FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'public')
     ) AS initialized`,
  );
  if (legacy[0]?.initialized) {
    await writeSentinel(pglite);
    return true;
  }

  return false;
};
