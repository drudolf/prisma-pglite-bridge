import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PRISMA_BIN,
  type PrismaProject,
  prismaPreamble,
  setupPrismaProject,
} from './utils/prisma.ts';
import { runCli } from './utils/run-cli.ts';
import { type StartedServer, startServer } from './utils/start-server.ts';

describe('prisma db execute against PGliteServer', () => {
  let started: StartedServer | undefined;
  let project: PrismaProject | undefined;

  afterEach(async () => {
    project?.cleanup();
    project = undefined;
    await started?.close();
    started = undefined;
  });

  it('runs a SQL script file against the database', async () => {
    started = await startServer();
    project = await setupPrismaProject(prismaPreamble());

    const sqlPath = path.join(project.dir, 'script.sql');
    await writeFile(
      sqlPath,
      `CREATE TABLE "Spring" (id serial primary key, tension int not null);
INSERT INTO "Spring" (tension) VALUES (10), (20), (30);
`,
      'utf8',
    );

    const DATABASE_URL = await started.server.listen();
    const result = await runCli(PRISMA_BIN, ['db', 'execute', '--file', sqlPath], {
      cwd: project.dir,
      env: {
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        DATABASE_URL,
      },
      timeoutMs: 30_000,
    });
    expect(result.code, result.stderr).toBe(0);

    const client = new pg.Client(DATABASE_URL);
    await client.connect();
    try {
      const r = await client.query<{ tension: number }>(
        'SELECT tension FROM "Spring" ORDER BY tension',
      );
      expect(r.rows.map((row) => row.tension)).toEqual([10, 20, 30]);
    } finally {
      await client.end();
    }
  });
});
