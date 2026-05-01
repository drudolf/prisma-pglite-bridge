import { afterEach, describe, expect, it } from 'vitest';

import {
  PRISMA_BIN,
  type PrismaProject,
  prismaPreamble,
  setupPrismaProject,
} from './utils/prisma.ts';
import { runCli } from './utils/run-cli.ts';
import { type StartedServer, startServer } from './utils/start-server.ts';

describe('prisma migrate status against createPGliteServer', () => {
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

  it('reports the database as up to date after migrate dev', async () => {
    const main = await startServer();
    const shadow = await startServer();
    started.push(main, shadow);

    const schema = `${prismaPreamble()}
model Latch {
  id Int @id @default(autoincrement())
}
`;
    project = await setupPrismaProject(schema);
    const env = {
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      DATABASE_URL: main.url,
      SHADOW_DATABASE_URL: shadow.url,
    };

    const dev = await runCli(PRISMA_BIN, ['migrate', 'dev', '--name', 'init'], {
      cwd: project.dir,
      env,
      timeoutMs: 90_000,
    });
    expect(dev.code, dev.stderr).toBe(0);

    const status = await runCli(PRISMA_BIN, ['migrate', 'status'], {
      cwd: project.dir,
      env,
      timeoutMs: 30_000,
    });
    expect(status.code, status.stderr).toBe(0);
    const output = status.stdout + status.stderr;
    expect(output).toMatch(/up to date|No pending migrations/i);
  });
});
