/**
 * Loads `.env.test` (if present) into a cached object and optionally
 * into `process.env` for bench scripts. Used by the postgres-pg adapter
 * to find `BENCH_POSTGRES_URL` / server PIDs. Missing file is a no-op so
 * in-process bench runs don't need any configuration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';

const ENV_TEST_PATH = join(import.meta.dirname, '..', '.env.test');

let envCache: Record<string, string> | null = null;

const loadEnvTest = (): Record<string, string> => {
  if (envCache) return envCache;

  if (!existsSync(ENV_TEST_PATH)) {
    envCache = {};
    return envCache;
  }

  envCache = parse(readFileSync(ENV_TEST_PATH, 'utf8'));
  return envCache;
};

export const loadBenchEnv = (): Record<string, string> => {
  const parsed = loadEnvTest();

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return parsed;
};

export const getEnvTest = (name: string): string | undefined => loadEnvTest()[name];

export const getBenchEnv = (name: string): string | undefined =>
  getEnvTest(name) ?? process.env[name];

export const envTestPath = ENV_TEST_PATH;
