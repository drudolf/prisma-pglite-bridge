import { PGlite } from '@electric-sql/pglite';

import { createPGliteServer, type PGliteServer } from '../../../create-pglite-server.ts';

export interface StartedServer {
  pglite: PGlite;
  server: PGliteServer;
  url: string;
  close: () => Promise<void>;
}

export const startServer = async (): Promise<StartedServer> => {
  const pglite = new PGlite();
  const server = await createPGliteServer({ pglite });

  return {
    pglite,
    server,
    /** Prisma 7's schema engine rejects URLs without a username (P1010). */
    url: server.url.replace('://', '://postgres@'),
    close: async () => {
      await server.close();
      await pglite.close();
    },
  };
};
