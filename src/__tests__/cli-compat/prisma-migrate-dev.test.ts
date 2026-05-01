import { readdir, readFile, writeFile } from 'node:fs/promises';
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

describe('prisma migrate dev against createPGliteServer', () => {
  const started: StartedServer[] = [];
  let project: PrismaProject | undefined;

  afterEach(async () => {
    project?.cleanup();
    project = undefined;
    while (started.length) {
      const s = started.pop();
      await s?.close();
    }
  });

  it('applies an initial migration and a follow-up migration on top', async () => {
    const main = await startServer();
    const shadow = await startServer();
    started.push(main, shadow);

    const initialSchema = `${prismaPreamble()}
model Sprocket {
  id   Int    @id @default(autoincrement())
  size Int
}
`;
    project = await setupPrismaProject(initialSchema);
    const env = {
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      DATABASE_URL: main.url,
      SHADOW_DATABASE_URL: shadow.url,
    };

    const initResult = await runCli(PRISMA_BIN, ['migrate', 'dev', '--name', 'init'], {
      cwd: project.dir,
      env,
      timeoutMs: 90_000,
    });
    expect(initResult.code, initResult.stderr).toBe(0);

    // Edit the schema to add a column, then run a second migration on top.
    const updatedSchema = `${prismaPreamble()}
model Sprocket {
  id    Int    @id @default(autoincrement())
  size  Int
  color String @default("red")
}
`;
    await writeFile(project.schemaPath, updatedSchema, 'utf8');

    const addColorResult = await runCli(PRISMA_BIN, ['migrate', 'dev', '--name', 'add_color'], {
      cwd: project.dir,
      env,
      timeoutMs: 90_000,
    });
    expect(addColorResult.code, addColorResult.stderr).toBe(0);

    // Two migration directories on disk, in order.
    const entries = (await readdir(project.migrationsDir))
      .filter((name) => name !== 'migration_lock.toml')
      .sort();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatch(/_init$/);
    expect(entries[1]).toMatch(/_add_color$/);

    const initSql = await readFile(
      path.join(project.migrationsDir, entries[0] as string, 'migration.sql'),
      'utf8',
    );
    expect(initSql).toMatch(/CREATE TABLE "Sprocket"/);

    const addColorSql = await readFile(
      path.join(project.migrationsDir, entries[1] as string, 'migration.sql'),
      'utf8',
    );
    expect(addColorSql).toMatch(/ALTER TABLE "Sprocket"/);
    expect(addColorSql).toMatch(/ADD COLUMN\s+"color"/);

    const client = new pg.Client({ connectionString: main.url });
    await client.connect();
    try {
      // Both migrations recorded in _prisma_migrations and finished.
      const history = await client.query<{ migration_name: string; finished_at: Date | null }>(
        `SELECT migration_name, finished_at FROM "_prisma_migrations"
         ORDER BY started_at ASC`,
      );
      expect(history.rows).toHaveLength(2);
      expect(history.rows[0]?.migration_name).toMatch(/_init$/);
      expect(history.rows[1]?.migration_name).toMatch(/_add_color$/);
      expect(history.rows[0]?.finished_at).not.toBeNull();
      expect(history.rows[1]?.finished_at).not.toBeNull();

      // New column is actually present in the main database.
      const cols = await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'Sprocket'
         ORDER BY column_name`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(['color', 'id', 'size']);
    } finally {
      await client.end();
    }
  });
});
