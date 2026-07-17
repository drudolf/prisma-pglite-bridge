import type { PGlite, PGliteInterface } from '@electric-sql/pglite';
import { PgBridgeError } from '../errors.ts';

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Operation timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
};

export const waitPGliteReady = async (
  pglite: PGlite | PGliteInterface,
  ms: number = Number.POSITIVE_INFINITY,
): Promise<void> => {
  if (pglite.ready) return;
  if (pglite.closed) throw new PgBridgeError('PGLITE_CLOSED', 'PGlite instance closed');

  try {
    await (Number.isFinite(ms) ? withTimeout(pglite.waitReady, ms) : pglite.waitReady);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new PgBridgeError('PGLITE_NOT_READY', `PGlite instance not ready: ${msg}`);
  }
};
