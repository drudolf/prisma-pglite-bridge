import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const basePath = () => mkdtempSync(join(tmpdir(), 'prisma-pglite-bridge-'));

export const createTempDir = (path: string, parent?: string): { parent: string; path: string } => {
  parent = parent || basePath();
  path = join(parent, path);
  mkdirSync(path);
  return { parent, path };
};

export const createTempFile = (
  file: string,
  content: string,
  parent?: string,
): { file: string; parent: string } => {
  parent = parent || basePath();
  file = join(parent, file);
  writeFileSync(file, content);
  return { parent, file };
};

export const removeTempDir = (path: string): string => {
  rmSync(path, { recursive: true, force: true });
  return path;
};
