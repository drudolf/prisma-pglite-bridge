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

describe('prisma migrate reset against createPGliteServer', () => {
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

  it('drops user data and re-applies migrations from disk', async () => {
    const main = await startServer();
    const shadow = await startServer();
    started.push(main, shadow);

    const schema = `${prismaPreamble()}
model Cog {
  id   Int    @id @default(autoincrement())
  teeth Int
}
`;
    project = await setupPrismaProject(schema);
    const env = {
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      DATABASE_URL: main.url,
      SHADOW_DATABASE_URL: shadow.url,
      // Prisma 7 detects AI-agent invocation and blocks destructive ops
      // unless this consent var is set. Tests target an ephemeral PGlite —
      // no real-DB risk.
      PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION:
        'cli-compat test suite: ephemeral PGlite database, no production data.',
    };

    // Set up state: one migration applied + a row of user data.
    const dev = await runCli(PRISMA_BIN, ['migrate', 'dev', '--name', 'init'], {
      cwd: project.dir,
      env,
      timeoutMs: 90_000,
    });
    expect(dev.code, dev.stderr).toBe(0);

    const seed = new pg.Client({ connectionString: main.url });
    await seed.connect();
    try {
      await seed.query('INSERT INTO "Cog" (teeth) VALUES (12), (24)');
      const before = await seed.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM "Cog"',
      );
      expect(before.rows[0]?.count).toBe('2');
    } finally {
      await seed.end();
    }

    // Reset must wipe the data and re-apply the migration in one shot.
    const reset = await runCli(PRISMA_BIN, ['migrate', 'reset', '--force'], {
      cwd: project.dir,
      env,
      timeoutMs: 90_000,
    });
    expect(reset.code, reset.stderr).toBe(0);

    const verify = new pg.Client({ connectionString: main.url });
    await verify.connect();
    try {
      const tableExists = await verify.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'Cog'`,
      );
      expect(tableExists.rowCount).toBe(1);

      const after = await verify.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM "Cog"',
      );
      expect(after.rows[0]?.count).toBe('0');

      const history = await verify.query<{ migration_name: string }>(
        `SELECT migration_name FROM "_prisma_migrations"
         WHERE finished_at IS NOT NULL`,
      );
      expect(history.rows).toHaveLength(1);
      expect(history.rows[0]?.migration_name).toMatch(/_init$/);
    } finally {
      await verify.end();
    }
  });
});
