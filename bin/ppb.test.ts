import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = resolve(REPO_ROOT, 'dist/ppb.mjs');

const SCHEMA_BASE = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model Widget {
  id   Int    @id @default(autoincrement())
  name String @unique
}
`;

const SCHEMA_DROP_COLUMN = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

model Widget {
  id Int @id @default(autoincrement())
}
`;

const SCHEMA_BAD = `not a valid prisma schema`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const runCli = (
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<RunResult> =>
  new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolveResult({ code, stdout, stderr });
    });
  });

describe('ppb CLI', () => {
  beforeAll(() => {
    if (!existsSync(BIN)) {
      execFileSync('pnpm', ['build'], { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  }, 120_000);

  const tmpRoots: string[] = [];
  const newTmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ppb-cli-'));
    tmpRoots.push(dir);
    return dir;
  };
  afterEach(() => {
    while (tmpRoots.length) {
      const d = tmpRoots.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  const writeSchema = (dir: string, content: string): string => {
    const path = join(dir, 'schema.prisma');
    writeFileSync(path, content);
    return path;
  };

  const tablesAt = async (dataDir: string): Promise<string[]> => {
    const pglite = new PGlite(dataDir);
    await pglite.waitReady;
    try {
      const r = await pglite.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' ORDER BY table_name
      `);
      return r.rows.map((row) => row.table_name);
    } finally {
      await pglite.close();
    }
  };

  it('dist/ppb.mjs has shebang and executable bit', () => {
    const content = readFileSync(BIN, 'utf8');
    expect(content.startsWith('#!')).toBe(true);
    const mode = statSync(BIN).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  it('db-push applies schema and exits 0', async () => {
    const tmp = newTmp();
    const schemaPath = writeSchema(tmp, SCHEMA_BASE);
    const dataDir = join(tmp, 'data');

    const result = await runCli(['db-push', '--schema', schemaPath, '--data-dir', dataDir]);

    expect(result.code).toBe(0);
    expect(await tablesAt(dataDir)).toContain('Widget');
  });

  it('db-push reads DATABASE_URL when --data-dir is omitted', async () => {
    const tmp = newTmp();
    const schemaPath = writeSchema(tmp, SCHEMA_BASE);
    const dataDir = join(tmp, 'data');

    const result = await runCli(['db-push', '--schema', schemaPath], {
      env: { DATABASE_URL: `pglite://${dataDir}` },
    });

    expect(result.code).toBe(0);
    expect(await tablesAt(dataDir)).toContain('Widget');
  });

  it('db-push exits 1 with warnings only and no --accept-data-loss', async () => {
    const tmp = newTmp();
    const schemaPath = writeSchema(tmp, SCHEMA_BASE);
    const dataDir = join(tmp, 'data');

    expect((await runCli(['db-push', '--schema', schemaPath, '--data-dir', dataDir])).code).toBe(0);

    const pglite = new PGlite(dataDir);
    await pglite.waitReady;
    await pglite.exec(`INSERT INTO "Widget" ("name") VALUES ('a'), ('b')`);
    await pglite.close();

    writeFileSync(schemaPath, SCHEMA_DROP_COLUMN);
    const result = await runCli(['db-push', '--schema', schemaPath, '--data-dir', dataDir]);

    expect(result.code).toBe(1);
    expect(result.stderr.toLowerCase()).toContain('warning');
  });

  it('db-push exits 0 with warnings and --accept-data-loss', async () => {
    const tmp = newTmp();
    const schemaPath = writeSchema(tmp, SCHEMA_BASE);
    const dataDir = join(tmp, 'data');

    expect((await runCli(['db-push', '--schema', schemaPath, '--data-dir', dataDir])).code).toBe(0);

    const pglite = new PGlite(dataDir);
    await pglite.waitReady;
    await pglite.exec(`INSERT INTO "Widget" ("name") VALUES ('a')`);
    await pglite.close();

    writeFileSync(schemaPath, SCHEMA_DROP_COLUMN);
    const result = await runCli([
      'db-push',
      '--schema',
      schemaPath,
      '--data-dir',
      dataDir,
      '--accept-data-loss',
    ]);

    expect(result.code).toBe(0);
  });

  it('db-push exits 1 on parse error with stderr containing engine message', async () => {
    const tmp = newTmp();
    const schemaPath = writeSchema(tmp, SCHEMA_BAD);
    const dataDir = join(tmp, 'data');

    const result = await runCli(['db-push', '--schema', schemaPath, '--data-dir', dataDir]);

    expect(result.code).toBe(1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  it('db-reset drops all user tables', async () => {
    const tmp = newTmp();
    const schemaPath = writeSchema(tmp, SCHEMA_BASE);
    const dataDir = join(tmp, 'data');

    expect((await runCli(['db-push', '--schema', schemaPath, '--data-dir', dataDir])).code).toBe(0);
    expect(await tablesAt(dataDir)).toContain('Widget');

    const result = await runCli(['db-reset', '--data-dir', dataDir]);
    expect(result.code).toBe(0);
    expect(await tablesAt(dataDir)).not.toContain('Widget');
  });
});
