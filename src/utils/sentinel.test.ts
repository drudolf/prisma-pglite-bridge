import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import setupPGlite from '../__tests__/pglite.ts';
import {
  isDatabaseInitialized,
  querySentinel,
  SENTINAL_COLLISON_ERROR_MESSAGE,
  SENTINEL_MARKER,
  SENTINEL_SCHEMA,
  SENTINEL_TABLE,
  writeSentinel,
} from './sentinel.ts';

const pglite = await setupPGlite();
beforeEach(async () => {
  await pglite.exec(`DROP TABLE IF EXISTS "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}"`);
  await pglite.exec(`DROP SCHEMA IF EXISTS "${SENTINEL_SCHEMA}"`);
});

describe('sentinel utilities', () => {
  it('reports an empty database as uninitialized', async () => {
    await expect(isDatabaseInitialized(pglite)).resolves.toBe(false);
  });

  it('marks a legacy initialized database with the sentinel row', async () => {
    await pglite.exec('CREATE TABLE users (id serial PRIMARY KEY)');

    await expect(isDatabaseInitialized(pglite)).resolves.toBe(true);
    await expect(querySentinel(pglite)).resolves.toEqual({
      marker: SENTINEL_MARKER,
      version: 1,
    });
  });

  it('recognizes an existing valid sentinel table as initialized', async () => {
    await writeSentinel(pglite);

    await expect(isDatabaseInitialized(pglite)).resolves.toBe(true);
    await expect(querySentinel(pglite)).resolves.toEqual({
      marker: SENTINEL_MARKER,
      version: 1,
    });
  });

  it('throws the collision error for an invalid sentinel row', async () => {
    await pglite.exec(
      `CREATE SCHEMA "${SENTINEL_SCHEMA}"; CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker text PRIMARY KEY, version int NOT NULL); INSERT INTO "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (marker, version) VALUES ('wrong-marker', 999)`,
    );

    await expect(querySentinel(pglite)).resolves.toEqual({
      marker: 'wrong-marker',
      version: 999,
    });
    await expect(writeSentinel(pglite)).rejects.toThrow(SENTINAL_COLLISON_ERROR_MESSAGE);
    await expect(isDatabaseInitialized(pglite)).rejects.toThrow(SENTINAL_COLLISON_ERROR_MESSAGE);
  });

  it('returns true when the sentinel table already contains the expected row', async () => {
    const pglite = {
      query: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ found: true }] })
        .mockResolvedValueOnce({ rows: [{ marker: SENTINEL_MARKER, version: 1 }] }),
    } as unknown as PGlite;

    await expect(isDatabaseInitialized(pglite)).resolves.toBe(true);
  });

  it('throws when the reserved sentinel schema exists without the sentinel table', async () => {
    await pglite.exec(`CREATE SCHEMA "${SENTINEL_SCHEMA}"`);

    await expect(isDatabaseInitialized(pglite)).rejects.toThrow(
      `Schema "${SENTINEL_SCHEMA}" exists but is not owned by prisma-pglite-bridge. The "${SENTINEL_SCHEMA}" schema is reserved for library metadata.`,
    );
  });

  it('throws the collision error for an incompatible sentinel table', async () => {
    await pglite.exec(
      `CREATE SCHEMA "${SENTINEL_SCHEMA}"; CREATE TABLE "${SENTINEL_SCHEMA}"."${SENTINEL_TABLE}" (broken text)`,
    );

    await expect(writeSentinel(pglite)).rejects.toThrow(SENTINAL_COLLISON_ERROR_MESSAGE);
    await expect(isDatabaseInitialized(pglite)).rejects.toThrow(SENTINAL_COLLISON_ERROR_MESSAGE);
  });

  it('wraps non-collision sentinel write failures with the collision error', async () => {
    const cause = new Error('boom');
    const pglite = {
      exec: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(cause),
    } as unknown as PGlite;

    const rejection = writeSentinel(pglite);

    await expect(rejection).rejects.toThrow(SENTINAL_COLLISON_ERROR_MESSAGE);
    await expect(rejection).rejects.toMatchObject({ cause });
    expect(vi.mocked(pglite.exec).mock.calls.at(-1)).toEqual(['ROLLBACK']);
  });
});
