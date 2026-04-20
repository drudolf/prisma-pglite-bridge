import type { PGlite } from '@electric-sql/pglite';

export const SENTINEL_SCHEMA = '_pglite_bridge';
export const SENTINEL_TABLE = '__initialized';
export const SENTINEL_MARKER = 'prisma-pglite-bridge:init:v1';

export interface SentinelRow {
  marker: string;
  version: number;
}

export const querySentinel = async (pglite: PGlite): Promise<SentinelRow | undefined> => {
  const { rows } = await pglite.query<SentinelRow>(
    `SELECT marker, version FROM "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" LIMIT 1`,
  );
  return rows[0];
};
