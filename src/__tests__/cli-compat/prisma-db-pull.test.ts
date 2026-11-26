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

const HIDE = { PRISMA_HIDE_UPDATE_MESSAGE: '1' };

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
      env: { ...HIDE, DATABASE_URL: await started.server.listen() },
      timeoutMs: 60_000,
    });
    expect(result.code, result.stderr).toBe(0);

    const regenerated = await readFile(project.schemaPath, 'utf8');
    expect(regenerated).toMatch(/model Gadget \{/);
    expect(regenerated).toMatch(/name\s+String/);
  });

  it('round-trips enums, foreign keys, unique and composite indexes through pull then push', async () => {
    started = await startServer();
    await started.pglite.exec(`
      CREATE TYPE "Status" AS ENUM ('ACTIVE', 'RETIRED');
      CREATE TABLE "Owner" (
        id     serial primary key,
        email  text not null unique,
        status "Status" not null default 'ACTIVE'
      );
      CREATE TABLE "Widget" (
        id          serial primary key,
        name        text not null,
        weight      double precision,
        "createdAt" timestamp(3) not null default current_timestamp,
        "ownerId"   integer not null references "Owner"(id) on delete cascade
      );
      CREATE INDEX "Widget_ownerId_name_idx" ON "Widget" ("ownerId", name);
    `);

    project = await setupPrismaProject(prismaPreamble());
    const DATABASE_URL = await started.server.listen();

    const pull = await runCli(PRISMA_BIN, ['db', 'pull'], {
      cwd: project.dir,
      env: { ...HIDE, DATABASE_URL },
      timeoutMs: 60_000,
    });
    expect(pull.code, pull.stderr).toBe(0);

    const pulled = await readFile(project.schemaPath, 'utf8');
    expect(pulled).toMatch(/enum Status \{/);
    expect(pulled).toMatch(/@relation\(fields: \[ownerId\], references: \[id\], onDelete: Cascade/);
    expect(pulled).toMatch(/email\s+String\s+@unique/);
    expect(pulled).toMatch(/@@index\(\[ownerId, name\]\)/);

    const push = await runCli(PRISMA_BIN, ['db', 'push'], {
      cwd: project.dir,
      env: { ...HIDE, DATABASE_URL },
      timeoutMs: 60_000,
    });
    expect(push.code, push.stderr).toBe(0);
    expect(push.stdout).toMatch(/already in sync/);
  });
});
