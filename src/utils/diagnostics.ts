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

/**
 * `node:diagnostics_channel` name for per-query events. Subscribers receive
 * a {@link QueryEvent} each time the bridge completes a query.
 */
export const QUERY_CHANNEL = 'prisma-pglite-bridge:query';

/**
 * `node:diagnostics_channel` name for per-acquisition session-lock wait
 * events. Subscribers receive a {@link LockWaitEvent} after each
 * acquisition completes.
 */
export const LOCK_WAIT_CHANNEL = 'prisma-pglite-bridge:lock-wait';

/** Payload published to {@link QUERY_CHANNEL}. */
export interface QueryEvent {
  /** Adapter identity tag — filter on this to isolate one adapter's events. */
  adapterId: symbol;
  /** Wall-clock duration of the query in milliseconds. */
  durationMs: number;
  /** `false` when the query rejected (protocol or SQL error). */
  succeeded: boolean;
}

/** Payload published to {@link LOCK_WAIT_CHANNEL}. */
export interface LockWaitEvent {
  /** Adapter identity tag — filter on this to isolate one adapter's events. */
  adapterId: symbol;
  /** Time spent waiting to acquire the session lock, in milliseconds. */
  durationMs: number;
}

export const queryChannel: diagnostics_channel.Channel = diagnostics_channel.channel(QUERY_CHANNEL);
export const lockWaitChannel: diagnostics_channel.Channel =
  diagnostics_channel.channel(LOCK_WAIT_CHANNEL);
