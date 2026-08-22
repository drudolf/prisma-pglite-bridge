// Placeholder: replaced at test runtime by setup.ts via `vi.mock` with the
// bridge-backed PrismaClient from bridge.ts. This stub never runs during the
// integration suite — it exists only so the import resolves and `prisma` has a
// type. Prisma 7's client requires a driver adapter at construction, which the
// placeholder has no access to, so it's a type-only cast, not a real instance.
import type { PrismaClient } from '../../../generated/prisma/client.ts';

export const prisma = {} as PrismaClient;
