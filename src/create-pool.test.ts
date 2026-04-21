import { describe, expect, it } from 'vitest';

import setupPGlite from './__tests__/pglite.ts';
import { createPool } from './create-pool.ts';

const pglite = await setupPGlite();
type RuntimePoolClient = import('pg').Client & {
  connectionParameters: {
    application_name?: string;
    database?: string;
    host?: string;
    user?: string;
  };
};
type PoolClientCtor = new (config?: string | import('pg').ClientConfig) => RuntimePoolClient;

describe('createPool — adapterId', async () => {
  it('returns a symbol, unique per call when omitted', async () => {
    const a = await createPool({ pglite });
    const b = await createPool({ pglite });
    try {
      expect(typeof a.adapterId).toBe('symbol');
      expect(typeof b.adapterId).toBe('symbol');
      expect(a.adapterId).not.toBe(b.adapterId);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('honors the adapterId passed in options', async () => {
    const adapterId = Symbol('custom');
    const pool = await createPool({ pglite, adapterId });
    try {
      expect(pool.adapterId).toBe(adapterId);
    } finally {
      await pool.close();
    }
  });
});

describe('createPool — custom Client config normalization', () => {
  it('supports undefined, string, and object client configs', async () => {
    const created = await createPool({ pglite });
    try {
      const Client = (created.pool as typeof created.pool & { Client: PoolClientCtor }).Client;

      const defaultClient = new Client();
      expect(defaultClient.connection.stream.constructor.name).toBe('PGliteBridge');
      expect(defaultClient.connectionParameters.user).toBe('postgres');
      expect(defaultClient.connectionParameters.database).toBe('postgres');

      const stringConfigClient = new Client('postgres://example/testdb');
      expect(stringConfigClient.connection.stream.constructor.name).toBe('PGliteBridge');
      expect(stringConfigClient.connectionParameters.host).toBe('example');
      expect(stringConfigClient.connectionParameters.database).toBe('testdb');

      const objectConfigClient = new Client({ application_name: 'create-pool-test' });
      expect(objectConfigClient.connection.stream.constructor.name).toBe('PGliteBridge');
      expect(objectConfigClient.connectionParameters.application_name).toBe('create-pool-test');
      expect(objectConfigClient.connectionParameters.user).toBe('postgres');
      expect(objectConfigClient.connectionParameters.database).toBe('postgres');
    } finally {
      await created.close();
    }
  });
});
