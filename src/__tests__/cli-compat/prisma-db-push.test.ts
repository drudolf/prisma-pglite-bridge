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

/**
 * Shapes chosen to drive every catalog the schema engine's introspection
 * reads: pg_enum (enum), pg_constraint 'f'/'u'/'p' and PG 18+'s 'n' rows
 * (relation, @unique, @id, required columns), pg_index (@@index), and
 * pg_attrdef (@default). The second push then has to introspect all of it
 * back and diff to zero.
 */
const RICH_SCHEMA = `${prismaPreamble()}
enum Status {
  ACTIVE
  RETIRED
}

model Owner {
  id      Int      @id @default(autoincrement())
  email   String   @unique
  status  Status   @default(ACTIVE)
  widgets Widget[]
}

model Widget {
  id        Int      @id @default(autoincrement())
  name      String
  weight    Float?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  ownerId   Int
  owner     Owner    @relation(fields: [ownerId], references: [id], onDelete: Cascade)

  @@index([ownerId, name])
}
`;

const HIDE = { PRISMA_HIDE_UPDATE_MESSAGE: '1' };

const dbPush = (cwd: string, DATABASE_URL: string) =>
  runCli(PRISMA_BIN, ['db', 'push'], {
    cwd,
    env: { ...HIDE, DATABASE_URL },
    timeoutMs: 60_000,
  });

describe('prisma db push against PGliteServer', () => {
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

    const DATABASE_URL = await started.server.listen();
    const result = await dbPush(project.dir, DATABASE_URL);
    expect(result.code, result.stderr).toBe(0);

    const client = new pg.Client(DATABASE_URL);
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

  it('introspects enums, relations, indexes and defaults back to an in-sync diff', async () => {
    started = await startServer();
    project = await setupPrismaProject(RICH_SCHEMA);
    const DATABASE_URL = await started.server.listen();

    const first = await dbPush(project.dir, DATABASE_URL);
    expect(first.code, first.stderr).toBe(0);

    const second = await dbPush(project.dir, DATABASE_URL);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toMatch(/already in sync/);
  });
});
