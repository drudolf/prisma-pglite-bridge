/**
 * TEXT[] decoder sweep — exercises the text-array text-format parser path
 * across array shapes covering tag-like (small + many short strings) through
 * payload-like (few + long strings).
 *
 * Each operation does N rounds of insert + raw SELECT at a fixed shape;
 * the SELECT drives the array parser. Iterations come from the runner's
 * `-n` flag.
 *
 * Uses raw SQL on a session-scoped TEMP TABLE so the scenario can run
 * against any adapter without schema additions.
 */
import { performance } from 'node:perf_hooks';
import { Prisma } from '@prisma/client';
import type { Scenario, ScenarioResult } from '../adapters/types.ts';

const setupTempTable = async (prisma: typeof import('@prisma/client').PrismaClient) => {
  await prisma.$executeRawUnsafe(
    'CREATE TEMP TABLE IF NOT EXISTS text_arr_t (id int PRIMARY KEY, tags text[])',
  );
  await prisma.$executeRawUnsafe('TRUNCATE TABLE text_arr_t');
};

const runTextArraySweep = async (
  prisma: typeof import('@prisma/client').PrismaClient,
  iterations: number,
  label: string,
  count: number,
  len: number,
): Promise<ScenarioResult> => {
  const item = 'a'.repeat(len);
  const arr = Array.from({ length: count }, () => item);
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    await setupTempTable(prisma);
    await prisma.$executeRaw`INSERT INTO text_arr_t (id, tags) VALUES (1, ${arr}::text[])`;
    const start = performance.now();
    await prisma.$queryRaw(Prisma.sql`SELECT tags FROM text_arr_t WHERE id = 1`);
    timings.push(performance.now() - start);
  }
  return { name: label, timings };
};

export const textArraySweep: Scenario = async (prisma, iterations) => {
  const results: ScenarioResult[] = [];

  // Tag-shaped: many small strings (typical Job.tags / Tenant.labels workloads).
  results.push(await runTextArraySweep(prisma, iterations, 'Text[] 10×16ch', 10, 16));
  results.push(await runTextArraySweep(prisma, iterations, 'Text[] 100×16ch', 100, 16));
  results.push(await runTextArraySweep(prisma, iterations, 'Text[] 1000×16ch', 1000, 16));

  // Payload-shaped: large strings inside the array (rare but worst-case for
  // the v2 char-by-char parser when each element has a long unquoted body).
  results.push(await runTextArraySweep(prisma, iterations, 'Text[] 100×1KB', 100, 1024));
  results.push(await runTextArraySweep(prisma, iterations, 'Text[] 10×100KB', 10, 100_000));

  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS text_arr_t');
  return results;
};
