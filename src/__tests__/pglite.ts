import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach } from 'vitest';

interface PGliteOptions {
  setup?: (pglite: PGlite) => Promise<void> | void;
  reset?: (pglite: PGlite) => Promise<void> | void;
}

/**
 * Canonical per-file PGlite pattern for tests:
 * creates one instance for the file, optionally prepares schema in `setup`,
 * resets state in `reset`, and closes it in `afterAll`.
 */
export const setupPGlite = (options: PGliteOptions = {}): (() => PGlite) => {
  let pglite: PGlite | undefined;

  beforeAll(async () => {
    pglite = new PGlite();
    await pglite.waitReady;
    await options.setup?.(pglite);
  });

  if (options.reset) {
    beforeEach(async () => {
      if (!pglite) throw new Error('setupPGlite accessed before beforeAll');
      await options.reset?.(pglite);
    });
  }

  afterAll(async () => {
    await pglite?.close();
    pglite = undefined;
  });

  return () => {
    if (!pglite) throw new Error('setupPGlite accessed before beforeAll');
    return pglite;
  };
};
