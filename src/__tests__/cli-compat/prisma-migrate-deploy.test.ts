import { mkdir, writeFile } from 'node:fs/promises';
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

describe('prisma migrate deploy against createPGliteServer', () => {
  let started: StartedServer | undefined;
  let project: PrismaProject | undefined;

  afterEach(async () => {
    project?.cleanup();
    project = undefined;
    await started?.close();
    started = undefined;
  });

  it('applies hand-authored migrations from disk to a fresh database', async () => {
    started = await startServer();
    project = await setupPrismaProject(prismaPreamble());

    // Hand-author two migration directories — `migrate deploy` does not look at
    // schema.prisma or use a shadow DB, so we only need the migrations folder
    // to exist with valid SQL.
    await writeFile(
      path.join(project.migrationsDir, 'migration_lock.toml'),
      'provider = "postgresql"\n',
      'utf8',
    );
    const m1 = path.join(project.migrationsDir, '20260101000000_init');
    const m2 = path.join(project.migrationsDir, '20260101000100_add_color');
    await mkdir(m1, { recursive: true });
    await mkdir(m2, { recursive: true });
    await writeFile(
      path.join(m1, 'migration.sql'),
      `CREATE TABLE "Bolt" (id serial primary key, length int not null);\n`,
      'utf8',
    );
    await writeFile(
      path.join(m2, 'migration.sql'),
      `ALTER TABLE "Bolt" ADD COLUMN "color" text NOT NULL DEFAULT 'red';\n`,
      'utf8',
    );

    const result = await runCli(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: project.dir,
      env: {
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        DATABASE_URL: started.url,
      },
      timeoutMs: 60_000,
    });
    expect(result.code, result.stderr).toBe(0);

    const client = new pg.Client({ connectionString: started.url });
    await client.connect();
    try {
      const history = await client.query<{
        migration_name: string;
        finished_at: Date | null;
      }>(
        `SELECT migration_name, finished_at FROM "_prisma_migrations"
         ORDER BY started_at ASC`,
      );
      expect(history.rows.map((r) => r.migration_name)).toEqual([
        '20260101000000_init',
        '20260101000100_add_color',
      ]);
      expect(history.rows.every((r) => r.finished_at !== null)).toBe(true);

      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'Bolt'
         ORDER BY column_name`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(['color', 'id', 'length']);
    } finally {
      await client.end();
    }
  });
});
