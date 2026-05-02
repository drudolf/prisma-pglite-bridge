/**
 * Bytea decoder sweep — exercises the bytea text-format decoder path
 * across a range of payload sizes for both `Bytes` (scalar) and `Bytes[]`
 * (array) columns. Designed to expose decoder-side asymmetries between
 * adapters (e.g. per-byte parseInt vs. native `Buffer.from(hex)`).
 *
 * Each operation does N rounds of (create + findUnique) at a fixed
 * shape; the findUnique drives the decoder. Iterations come from the
 * runner's `-n` flag.
 */
import { performance } from 'node:perf_hooks';
import type { Scenario, ScenarioResult } from '../adapters/types.ts';

const resetBlobs = async (prisma: typeof import('@prisma/client').PrismaClient) => {
  await prisma.blob.deleteMany();
};

const fillBuffer = (size: number, byte: number) => Buffer.alloc(size, byte);

const runScalarSweep = async (
  prisma: typeof import('@prisma/client').PrismaClient,
  iterations: number,
  label: string,
  size: number,
): Promise<ScenarioResult> => {
  const payload = fillBuffer(size, 0xab);
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    await resetBlobs(prisma);
    const created = await prisma.blob.create({
      data: { name: `${label}-${i}`, data: payload, size },
    });
    const start = performance.now();
    await prisma.blob.findUnique({ where: { id: created.id } });
    timings.push(performance.now() - start);
  }
  return { name: label, timings };
};

const runArraySweep = async (
  prisma: typeof import('@prisma/client').PrismaClient,
  iterations: number,
  label: string,
  chunkCount: number,
  chunkSize: number,
): Promise<ScenarioResult> => {
  const chunk = fillBuffer(chunkSize, 0xab);
  const chunks = Array.from({ length: chunkCount }, () => chunk);
  const timings: number[] = [];
  for (let i = 0; i < iterations; i++) {
    await resetBlobs(prisma);
    const created = await prisma.blob.create({
      data: {
        name: `${label}-${i}`,
        data: Buffer.alloc(0),
        size: chunkCount * chunkSize,
        chunks,
      },
    });
    const start = performance.now();
    await prisma.blob.findUnique({ where: { id: created.id } });
    timings.push(performance.now() - start);
  }
  return { name: label, timings };
};

export const bytesSweep: Scenario = async (prisma, iterations) => {
  const results: ScenarioResult[] = [];

  results.push(await runScalarSweep(prisma, iterations, 'Bytes 10KB', 10_000));
  results.push(await runScalarSweep(prisma, iterations, 'Bytes 100KB', 100_000));
  results.push(await runScalarSweep(prisma, iterations, 'Bytes 1MB', 1_000_000));
  results.push(await runScalarSweep(prisma, iterations, 'Bytes 10MB', 10_000_000));

  results.push(await runArraySweep(prisma, iterations, 'Bytes[] 100×10KB', 100, 10_000));
  results.push(await runArraySweep(prisma, iterations, 'Bytes[] 50×100KB', 50, 100_000));
  results.push(await runArraySweep(prisma, iterations, 'Bytes[] 10×1MB', 10, 1_000_000));

  await resetBlobs(prisma);
  return results;
};
