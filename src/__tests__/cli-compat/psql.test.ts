import { afterEach, describe, expect, it } from 'vitest';

import { hasPsql } from './utils/psql.ts';
import { runCli } from './utils/run-cli.ts';
import { type StartedServer, startServer } from './utils/start-server.ts';

const psqlEnv = (server: StartedServer['server']): NodeJS.ProcessEnv => ({
  PGHOST: server.host,
  PGPORT: String(server.port),
  PGUSER: 'anyone',
  PGDATABASE: 'postgres',
  PGSSLMODE: 'disable',
});

describe.skipIf(!hasPsql)('psql against createPGliteServer', () => {
  let started: StartedServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
  });

  it('runs SELECT 1 and exits 0', async () => {
    started = await startServer();
    const result = await runCli('psql', ['-At', '-c', 'SELECT 1'], {
      env: psqlEnv(started.server),
      timeoutMs: 15_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe('1');
  });

  it('runs DDL + DML + SELECT roundtrip', async () => {
    started = await startServer();
    const sql = `
      CREATE TABLE t (id int primary key, name text);
      INSERT INTO t VALUES (1, 'a'), (2, 'b');
      SELECT id, name FROM t ORDER BY id;
    `;
    const result = await runCli('psql', ['-At', '-F', '|', '-c', sql], {
      env: psqlEnv(started.server),
      timeoutMs: 15_000,
    });
    expect(result.code).toBe(0);
    const rows = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+\|/.test(line));
    expect(rows).toEqual(['1|a', '2|b']);
  });

  it('lists tables via \\dt metacommand', async () => {
    started = await startServer();
    await runCli('psql', ['-c', 'CREATE TABLE widgets (id int primary key)'], {
      env: psqlEnv(started.server),
      timeoutMs: 15_000,
    });
    const result = await runCli('psql', ['-c', '\\dt'], {
      env: psqlEnv(started.server),
      timeoutMs: 15_000,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/widgets/);
  });
});
