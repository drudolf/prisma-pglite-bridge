import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PGliteBridge } from '../../pglite-bridge';
import { PGliteServer } from '../../pglite-server';
import { listMigrations, pushMigrations } from '../../schema/migrations.ts';
import {
  PRISMA_BIN,
  type PrismaProject,
  prismaPreamble,
  setupPrismaProject,
} from './utils/prisma.ts';
import { runCli } from './utils/run-cli.ts';
import { type StartedServer, startServer } from './utils/start-server.ts';

/**
 * `pushMigrations` writes `_prisma_migrations` the way `prisma migrate deploy`
 * does. These tests hand a database populated by `pushMigrations` to the real
 * Prisma CLI (through PGliteServer) and assert the CLI treats it as its own.
 */

const HIDE = { PRISMA_HIDE_UPDATE_MESSAGE: '1' };

interface ColumnRow {
  column_name: string;
  data_type: string;
  character_maximum_length: number | null;
  is_nullable: string;
  column_default: string | null;
}

interface HistoryRow {
  migration_name: string;
  checksum: string;
  applied_steps_count: number;
  finished_at: Date | null;
}

const withClient = async <T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client(url);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

const readColumns = (url: string): Promise<ColumnRow[]> =>
  withClient(url, async (client) => {
    const { rows } = await client.query<ColumnRow>(
      `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = '_prisma_migrations'
       ORDER BY ordinal_position`,
    );
    return rows;
  });

const readHistory = (url: string): Promise<HistoryRow[]> =>
  withClient(url, async (client) => {
    const { rows } = await client.query<HistoryRow>(
      `SELECT migration_name, checksum, applied_steps_count, finished_at
       FROM "_prisma_migrations" ORDER BY started_at ASC`,
    );
    return rows;
  });

const migrateStatus = async (cwd: string, DATABASE_URL: string) => {
  const status = await runCli(PRISMA_BIN, ['migrate', 'status'], {
    cwd,
    env: { ...HIDE, DATABASE_URL },
    timeoutMs: 30_000,
  });
  return { ...status, output: status.stdout + status.stderr };
};

const expectUpToDate = async (cwd: string, DATABASE_URL: string): Promise<void> => {
  const status = await migrateStatus(cwd, DATABASE_URL);
  expect(status.code, status.output).toBe(0);
  expect(status.output).toMatch(/up to date|No pending migrations/i);
};

/** `migrate dev --name init` on a throwaway main+shadow pair, to obtain a real migration directory. */
const generateWithMigrateDev = async (
  project: PrismaProject,
  name: string,
): Promise<{ code: number; output: string }> => {
  const main = await startServer();
  const shadow = await startServer();
  try {
    const dev = await runCli(PRISMA_BIN, ['migrate', 'dev', '--name', name], {
      cwd: project.dir,
      env: {
        ...HIDE,
        DATABASE_URL: await main.server.listen(),
        SHADOW_DATABASE_URL: await shadow.server.listen(),
      },
      timeoutMs: 90_000,
    });
    return { code: dev.code, output: dev.stdout + dev.stderr };
  } finally {
    await shadow.close();
    await main.close();
  }
};

const WIDGET_SCHEMA = `${prismaPreamble()}
model Widget {
  id   Int    @id @default(autoincrement())
  name String
}
`;

describe('pushMigrations history seen by the Prisma CLI', () => {
  // One real `migrate dev`-generated project shared by the tests below.
  let initProject: PrismaProject;
  let initMigrationName: string;

  beforeAll(async () => {
    initProject = await setupPrismaProject(WIDGET_SCHEMA);
    const dev = await generateWithMigrateDev(initProject, 'init');
    expect(dev.code, dev.output).toBe(0);
    const names = listMigrations(initProject.migrationsDir).map((m) => m.name);
    expect(names).toHaveLength(1);
    initMigrationName = names[0] as string;
    expect(initMigrationName).toMatch(/^\d{14}_init$/);
  }, 120_000);

  afterAll(() => {
    initProject?.cleanup();
  });

  const started: StartedServer[] = [];
  const projects: PrismaProject[] = [];
  afterEach(async () => {
    while (projects.length) projects.pop()?.cleanup();
    while (started.length) {
      const s = started.pop();
      await s?.close();
    }
  });

  it('(i) migrate status and migrate deploy see a pushMigrations database as up to date', async () => {
    const fresh = await startServer();
    started.push(fresh);

    const result = await pushMigrations(fresh.pglite, {
      migrationsPath: initProject.migrationsDir,
    });
    expect(result.applied).toEqual([initMigrationName]);

    const url = await fresh.server.listen();
    await expectUpToDate(initProject.dir, url);

    const deploy = await runCli(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: initProject.dir,
      env: { ...HIDE, DATABASE_URL: url },
      timeoutMs: 60_000,
    });
    expect(deploy.code, deploy.stderr).toBe(0);
    expect(deploy.stdout + deploy.stderr).toMatch(/No pending migrations to apply/);
    expect(await readHistory(url)).toHaveLength(1);
  }, 120_000);

  it('(ii) the engine-created and the pushMigrations-created _prisma_migrations tables match', async () => {
    const bridgeSide = await startServer();
    const engineSide = await startServer();
    started.push(bridgeSide, engineSide);

    await pushMigrations(bridgeSide.pglite, { migrationsPath: initProject.migrationsDir });
    const bridgeUrl = await bridgeSide.server.listen();

    const engineUrl = await engineSide.server.listen();
    const deploy = await runCli(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: initProject.dir,
      env: { ...HIDE, DATABASE_URL: engineUrl },
      timeoutMs: 60_000,
    });
    expect(deploy.code, deploy.stderr).toBe(0);

    const engineColumns = await readColumns(engineUrl);
    const bridgeColumns = await readColumns(bridgeUrl);
    expect(engineColumns.length).toBeGreaterThan(0);
    expect(bridgeColumns).toEqual(engineColumns);

    const [engineRow] = await readHistory(engineUrl);
    const [bridgeRow] = await readHistory(bridgeUrl);
    expect(engineRow?.migration_name).toBe(initMigrationName);
    expect(bridgeRow?.migration_name).toBe(initMigrationName);
    expect(bridgeRow?.checksum).toBe(engineRow?.checksum);
    expect(
      bridgeRow?.applied_steps_count,
      `applied_steps_count differs: engine=${engineRow?.applied_steps_count} bridge=${bridgeRow?.applied_steps_count}`,
    ).toBe(engineRow?.applied_steps_count);
    expect(bridgeRow?.applied_steps_count).toBe(1);
  }, 120_000);

  it('(iii) migrate dev on a reopened dataDir sees the pushed history (CRLF script) as in sync', async () => {
    const project = await setupPrismaProject(`${prismaPreamble()}
model Widget {
  id    Int    @id @default(autoincrement())
  name  String
  color String @default("red")
}
`);
    projects.push(project);
    cpSync(initProject.migrationsDir, project.migrationsDir, { recursive: true });
    const addColorName = '20990101000000_add_color';
    await mkdir(path.join(project.migrationsDir, addColorName));
    await writeFile(
      path.join(project.migrationsDir, addColorName, 'migration.sql'),
      `-- AlterTable\r\nALTER TABLE "Widget" ADD COLUMN     "color" TEXT NOT NULL DEFAULT 'red';\r\n`,
      'utf8',
    );

    const dataDir = mkdtempSync(path.join(tmpdir(), 'ppb-datadir-'));
    try {
      const first = new PGlite(dataDir);
      const firstServer = new PGliteServer({ pglite: first });
      const pushed = await pushMigrations(first, { migrationsPath: project.migrationsDir });
      expect(pushed.applied).toEqual([initMigrationName, addColorName]);
      await firstServer.close();
      await first.close();

      const reopened = new PGlite(dataDir);
      const reopenedServer = new PGliteServer({ pglite: reopened });
      const shadow = await startServer();
      started.push(shadow);
      try {
        const dev = await runCli(PRISMA_BIN, ['migrate', 'dev'], {
          cwd: project.dir,
          env: {
            ...HIDE,
            DATABASE_URL: await reopenedServer.listen(),
            SHADOW_DATABASE_URL: await shadow.server.listen(),
          },
          timeoutMs: 90_000,
        });
        const output = dev.stdout + dev.stderr;
        expect(dev.code, output).toBe(0);
        expect(output).not.toMatch(/drift|reset/i);
        // The CLI's exact no-op line for a history it recognizes as complete.
        expect(output).toMatch(
          /Already in sync, no schema change or pending migration was found\./,
        );

        const again = await pushMigrations(reopened, { migrationsPath: project.migrationsDir });
        expect(again).toMatchObject({ applied: [], skipped: [initMigrationName, addColorName] });
      } finally {
        await reopenedServer.close();
        await reopened.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);

  it('(iv) multiSchema migrations round-trip through pushMigrations', async () => {
    const project = await setupPrismaProject(`datasource db {
  provider = "postgresql"
  schemas  = ["public", "audit"]
}

model Order {
  id Int @id @default(autoincrement())

  @@schema("public")
}

model AuditLog {
  id Int @id @default(autoincrement())

  @@schema("audit")
}
`);
    projects.push(project);
    const dev = await generateWithMigrateDev(project, 'init');
    expect(dev.code, dev.output).toBe(0);
    const [migration] = listMigrations(project.migrationsDir);
    expect(migration?.sql).toMatch(/CREATE SCHEMA IF NOT EXISTS "audit"/);

    const fresh = await startServer();
    started.push(fresh);
    const result = await pushMigrations(fresh.pglite, { migrationsPath: project.migrationsDir });
    expect(result.applied).toEqual([migration?.name]);

    const url = await fresh.server.listen();
    await expectUpToDate(project.dir, url);
    const tables = await withClient(url, async (client) => {
      const { rows } = await client.query<{ table_schema: string; table_name: string }>(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_schema IN ('public', 'audit') ORDER BY 1, 2`,
      );
      return rows.map((r) => `${r.table_schema}.${r.table_name}`);
    });
    expect(tables).toEqual(['audit.AuditLog', 'public.Order', 'public._prisma_migrations']);
  }, 180_000);

  it('(v) the pushed history survives bridge.snapshotDb() + resetDb()', async () => {
    const fresh = await startServer();
    started.push(fresh);
    await pushMigrations(fresh.pglite, { migrationsPath: initProject.migrationsDir });

    const bridge = new PGliteBridge({ pglite: fresh.pglite });
    await bridge.snapshotDb();
    await bridge.resetDb();
    await bridge.close();

    const url = await fresh.server.listen();
    await expectUpToDate(initProject.dir, url);
    const again = await pushMigrations(fresh.pglite, {
      migrationsPath: initProject.migrationsDir,
    });
    expect(again).toMatchObject({ applied: [], skipped: [initMigrationName] });
  }, 120_000);

  it('(vi) applies migrations in the same order the engine does (localeCompare, not code points)', async () => {
    const project = await setupPrismaProject(prismaPreamble());
    projects.push(project);
    await writeFile(
      path.join(project.migrationsDir, 'migration_lock.toml'),
      'provider = "postgresql"\n',
      'utf8',
    );
    // Same timestamp prefix so only the suffix decides the order: code-point
    // order would be B, a, ä; the CLI's localeCompare puts a first.
    const fixtures: Array<[string, string]> = [
      ['20240101000000_a', 'CREATE TABLE "Ta" ("id" TEXT PRIMARY KEY);\n'],
      ['20240101000000_B', 'CREATE TABLE "Tb" ("id" TEXT PRIMARY KEY);\n'],
      ['20240101000000_ä', 'CREATE TABLE "Tc" ("id" TEXT PRIMARY KEY);\n'],
    ];
    for (const [name, sql] of fixtures) {
      await mkdir(path.join(project.migrationsDir, name));
      await writeFile(path.join(project.migrationsDir, name, 'migration.sql'), sql, 'utf8');
    }
    const listed = listMigrations(project.migrationsDir).map((m) => m.name);
    expect(listed).not.toEqual(fixtures.map(([name]) => name).sort());

    const bridgeSide = await startServer();
    const engineSide = await startServer();
    started.push(bridgeSide, engineSide);

    const pushed = await pushMigrations(bridgeSide.pglite, {
      migrationsPath: project.migrationsDir,
    });
    expect(pushed.applied).toEqual(listed);
    await expectUpToDate(project.dir, await bridgeSide.server.listen());

    const engineUrl = await engineSide.server.listen();
    const deploy = await runCli(PRISMA_BIN, ['migrate', 'deploy'], {
      cwd: project.dir,
      env: { ...HIDE, DATABASE_URL: engineUrl },
      timeoutMs: 60_000,
    });
    expect(deploy.code, deploy.stderr).toBe(0);
    const engineOrder = (await readHistory(engineUrl)).map((r) => r.migration_name);
    expect(engineOrder).toEqual(pushed.applied);
    expect(engineOrder).toEqual(['20240101000000_a', '20240101000000_ä', '20240101000000_B']);
  }, 120_000);
});
