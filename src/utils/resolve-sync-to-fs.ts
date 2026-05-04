import type { PGlite, PGliteInterface } from '@electric-sql/pglite';

export type SyncToFsMode = 'auto' | boolean;

export const resolveSyncToFs = (pglite: PGlite | PGliteInterface, mode?: SyncToFsMode): boolean => {
  if (typeof mode === 'boolean') return mode;
  return !!pglite.dataDir && !pglite.dataDir.startsWith('memory://');
};
