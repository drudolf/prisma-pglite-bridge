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

describe('prisma db push against createPGliteServer', () => {
  let started: StartedServer | undefined;
  let project: PrismaProject | undefined;

  afterEach(async () => {
    project?.cleanup();
    project = undefined;
    await started?.close();
    started = undefined;
  });

  it('applies schema.prisma and creates the table', async () => {
    started = await startServer();
    const schema = `${prismaPreamble()}
model Widget {
  id   Int    @id @default(autoincrement())
  name String
}
`;
    project = await setupPrismaProject(schema);

    const result = await runCli(PRISMA_BIN, ['db', 'push'], {
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
      const r = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'Widget'`,
      );
      expect(r.rowCount).toBe(1);
    } finally {
      await client.end();
    }
  });
});
