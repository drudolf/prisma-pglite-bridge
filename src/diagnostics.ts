/**
 * Public `node:diagnostics_channel` surface.
 *
 * The bridge publishes per-query and per-lock-wait events to named
 * channels. External consumers (OpenTelemetry, APM tools, custom
 * loggers) can subscribe without touching the library API. Built-in
 * adapter stats are updated directly from the bridge and are
 * independent of these public channels.
 *
 * Publication is gated by `channel.hasSubscribers`, so the hot path
 * pays no cost when nobody is listening. Subscribing opts the consumer
 * in to the timing/publication overhead.
 *
 * Filter on `adapterId` to distinguish events from different adapters
 * in the same process — obtain it from the `createPgliteAdapter` or
 * `createPool` return value.
 */
import diagnostics_channel from 'node:diagnostics_channel';

export const QUERY_CHANNEL = 'prisma-pglite-bridge:query';
export const LOCK_WAIT_CHANNEL = 'prisma-pglite-bridge:lock-wait';

export interface QueryEvent {
  adapterId: symbol;
  durationMs: number;
  succeeded: boolean;
}

export interface LockWaitEvent {
  adapterId: symbol;
  durationMs: number;
}

export const queryChannel: diagnostics_channel.Channel = diagnostics_channel.channel(QUERY_CHANNEL);
export const lockWaitChannel: diagnostics_channel.Channel =
  diagnostics_channel.channel(LOCK_WAIT_CHANNEL);
