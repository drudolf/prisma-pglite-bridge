import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../../../../..');
export const PRISMA_BIN: string = path.join(REPO_ROOT, 'node_modules/.bin/prisma');

export interface PrismaProject {
  dir: string;
  schemaPath: string;
  migrationsDir: string;
  cleanup: () => void;
}

/**
 * Scaffold a temporary Prisma project with a single schema file plus the
 * Prisma 7 `prisma.config.ts` (which is where the datasource URL must live —
 * 7.x rejects `url` inside `datasource` blocks). The config reads
 * `DATABASE_URL` and (optionally) `SHADOW_DATABASE_URL` from env so callers
 * can vary the URL per test without rewriting the file.
 */
export const setupPrismaProject = async (schema: string): Promise<PrismaProject> => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ppb-cli-'));
  const prismaDir = path.join(dir, 'prisma');
  const migrationsDir = path.join(prismaDir, 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  const schemaPath = path.join(prismaDir, 'schema.prisma');
  await writeFile(schemaPath, schema, 'utf8');
  const configPath = path.join(dir, 'prisma.config.ts');
  await writeFile(
    configPath,
    `import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: './prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
`,
    'utf8',
  );
  return {
    dir,
    schemaPath,
    migrationsDir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
};

/**
 * Minimal datasource preamble. URL lives in `prisma.config.ts`. No generator
 * block: tmp projects don't install `@prisma/client`, so triggering `generate`
 * (which `migrate dev` does unconditionally in Prisma 7) would fail.
 */
export const prismaPreamble = (): string =>
  `datasource db {
  provider = "postgresql"
}
`;
