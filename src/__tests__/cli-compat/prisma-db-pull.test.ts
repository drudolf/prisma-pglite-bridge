import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';

import {
  PRISMA_BIN,
  type PrismaProject,
  prismaPreamble,
  setupPrismaProject,
} from './utils/prisma.ts';
import { runCli } from './utils/run-cli.ts';
import { type StartedServer, startServer } from './utils/start-server.ts';

describe('prisma db pull against PGliteServer', () => {
  let started: StartedServer | undefined;
  let project: PrismaProject | undefined;

  afterEach(async () => {
    project?.cleanup();
    project = undefined;
    await started?.close();
    started = undefined;
  });

  it('introspects an existing table into schema.prisma', async () => {
    started = await startServer();
    await started.pglite.exec(`
      CREATE TABLE "Gadget" (
        id   serial primary key,
        name text not null
      );
    `);

    project = await setupPrismaProject(prismaPreamble());

    const result = await runCli(PRISMA_BIN, ['db', 'pull'], {
      cwd: project.dir,
      env: {
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        DATABASE_URL: await started.server.listen(),
      },
      timeoutMs: 60_000,
    });
    expect(result.code, result.stderr).toBe(0);

    const regenerated = await readFile(project.schemaPath, 'utf8');
    expect(regenerated).toMatch(/model Gadget \{/);
    expect(regenerated).toMatch(/name\s+String/);
  });
});
