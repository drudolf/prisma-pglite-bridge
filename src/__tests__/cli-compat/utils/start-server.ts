import { PGlite } from '@electric-sql/pglite';

import { PGliteServer } from '../../../pglite-server';

export interface StartedServer {
  pglite: PGlite;
  server: PGliteServer;
  close: () => Promise<void>;
}

export const startServer = async (): Promise<StartedServer> => {
  const pglite = new PGlite();
  await pglite.waitReady;

  const server = new PGliteServer({ pglite });

  return {
    pglite,
    server,
    close: async () => {
      await server.close();
    },
  };
};
