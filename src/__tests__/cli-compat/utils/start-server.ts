import type { PGliteInterface } from '@electric-sql/pglite';

import { PGliteServer } from '../../../pglite-server';

export interface StartedServer {
  pglite: PGliteInterface;
  server: PGliteServer;
  close: () => Promise<void>;
}

export const startServer = async (): Promise<StartedServer> => {
  const server = new PGliteServer();
  await server.pglite.waitReady;

  return {
    pglite: server.pglite,
    server,
    close: async () => {
      await server.close();
    },
  };
};
