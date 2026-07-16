import type { PgBridgeClient } from './pg-bridge-client.ts';

/**
 * Session-scope registries keyed by the shared PGlite instance. PGlite is one
 * shared session per instance, and all three of these coordinate cross-pool /
 * cross-client behavior on that session — so they live together in one owner
 * rather than split across the pool and client modules. Keying off the PGlite
 * instance (a `WeakMap`) lets the entries be collected with the instance.
 *
 * Three structures rather than one count + set because they track different
 * lifecycles: pools (constructor → end()), connected clients ('connect' →
 * 'remove'), and constructed clients (constructor → 'end'). A client that
 * errors before 'connect' — or dies without a graceful 'remove' — exists in
 * `liveClients` but never counted in `liveClientCounts`.
 */

/** Live pools per PGlite instance. Drives the PGliteBridgeSharedInstanceWarning. */
export const livePoolCounts: WeakMap<object, number> = new WeakMap();

/**
 * Total pg.Client instances across ALL pools per PGlite instance.
 * Incremented in 'connect', decremented in 'remove'. The connect-time
 * DEALLOCATE ALL guard checks this instead of per-pool totalCount so that a
 * new pool's first client never wipes a sibling pool's server-side named
 * statements mid-flight (would cause 26000 on the sibling's next Bind).
 */
export const liveClientCounts: WeakMap<object, number> = new WeakMap();

/**
 * Live clients per PGlite instance. PGlite is one shared session: a
 * DEALLOCATE / DISCARD ALL issued through ANY client wipes server-side
 * statements that every client's pg parse-skip cache may still reference.
 * The registry lets the dealloc intercept in query() evict from all live
 * clients, not just the issuer. Clients register at construction and
 * deregister on their own 'end' event plus a belt-and-suspenders hook in
 * PgBridgePool's 'remove' listener; a stale entry is harmless — evicting a
 * dead client's caches is a no-op.
 */
export const liveClients: WeakMap<object, Set<PgBridgeClient>> = new WeakMap();
