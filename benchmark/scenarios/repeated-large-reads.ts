/**
 * Repeated large-read benchmark — isolates Prisma-level repeated reads over
 * a single 1MB JSON row so read-path regressions show up without the noise of
 * writes, setup-heavy suites, or stack-attribution sampling.
 *
 * Intended invocation:
 *   pnpm bench --scenario repeated-large-reads -n 100 -w 10
 */
import type { Scenario } from '../adapters/types.ts';

const ONE_MB = 1024 * 1024;
const REPEATED_READ_COUNT = 20;

const makeLargeJson = (run: number) => ({
  mode: 'repeated-large-reads',
  run,
  ok: true,
  blob: 'x'.repeat(ONE_MB),
  meta: {
    tags: ['alpha', 'beta', 'gamma'],
    nested: { level: 1, enabled: true },
  },
});

const timeOp = async (fn: () => Promise<unknown>): Promise<number> => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

const resetTenants = async (prisma: typeof import('@prisma/client').PrismaClient) => {
  await prisma.tenant.deleteMany();
};

const SQL = `
  SELECT id, name, slug, config, labels, "createdAt"
  FROM "Tenant"
  WHERE id = $1
`;

export const repeatedLargeReads: Scenario = async (prisma, iterations) => {
  const queryRawTimings: number[] = [];
  const findUniqueTimings: number[] = [];

  for (let run = 0; run < iterations; run++) {
    await resetTenants(prisma);
    const tenant = await prisma.tenant.create({
      data: {
        name: `repeated-large-read-${run}`,
        slug: `repeated-large-read-${run}`,
        config: makeLargeJson(run),
        labels: ['alpha', 'beta'],
      },
    });

    queryRawTimings.push(
      await timeOp(async () => {
        for (let i = 0; i < REPEATED_READ_COUNT; i++) {
          await prisma.$queryRawUnsafe(SQL, tenant.id);
        }
      }),
    );

    findUniqueTimings.push(
      await timeOp(async () => {
        for (let i = 0; i < REPEATED_READ_COUNT; i++) {
          await prisma.tenant.findUnique({
            where: { id: tenant.id },
            select: {
              id: true,
              name: true,
              slug: true,
              config: true,
              labels: true,
              createdAt: true,
            },
          });
        }
      }),
    );
  }

  return [
    { name: `prisma $queryRaw 1MB JSON ×${REPEATED_READ_COUNT}`, timings: queryRawTimings },
    { name: `prisma findUnique 1MB JSON ×${REPEATED_READ_COUNT}`, timings: findUniqueTimings },
  ];
};
