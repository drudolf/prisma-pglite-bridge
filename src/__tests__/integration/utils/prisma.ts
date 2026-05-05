// Placeholder: replaced at test runtime by setup.ts via `vi.mock` with the
// bridge-backed PrismaClient from bridge.ts. The `new PrismaClient()` below
// never actually runs during the integration suite — it's here only so the
// import resolves and `prisma` has a type.
import { PrismaClient } from '@prisma/client';

export const prisma: PrismaClient = new PrismaClient();
