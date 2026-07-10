/**
 * LISTEN/NOTIFY — async NotificationResponse delivery through the
 * duplex. All pool clients share ONE PGlite session, so LISTEN
 * registrations are session-wide; this probe checks whether pg's
 * 'notification' event fires at all on the wire path, with payload.
 */

import type { CompatProbe } from './types.ts';
import { withTimeout } from './types.ts';

export const listenNotify: CompatProbe = {
  name: 'listen-notify',
  summary: "LISTEN/NOTIFY async delivery to pg's 'notification' event",
  run: async ({ pool }) => {
    const details: string[] = [];
    const client = await pool.connect();
    try {
      const arrived = new Promise<{ channel: string; payload?: string }>((resolve) => {
        client.once('notification', (msg) => resolve(msg));
      });

      await client.query('LISTEN compat_channel');
      // Same session: Postgres delivers self-notifications after the
      // (implicit) transaction commits.
      await client.query("NOTIFY compat_channel, 'hello-bridge'");

      const msg = await withTimeout(3_000, 'notification delivery', arrived);
      if (msg.channel !== 'compat_channel' || msg.payload !== 'hello-bridge') {
        return {
          status: 'fail',
          details: [`notification arrived but malformed: ${JSON.stringify(msg)}`],
        };
      }
      details.push("self-NOTIFY delivered to 'notification' listener with payload");

      await client.query('UNLISTEN compat_channel');
      details.push('UNLISTEN accepted');
      return { status: 'pass', details };
    } finally {
      client.release();
    }
  },
};
