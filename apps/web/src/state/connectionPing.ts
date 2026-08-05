/**
 * Round-trip latency to each connected machine.
 *
 * Fork-owned, and the only latency measurement in the app: upstream's
 * `requestLatencyState.ts` is a slow-request watchdog that records when a
 * request started and never subtracts it, and there is no WS heartbeat.
 *
 * What is measured is the *existing* `RpcSession.probe` — the same effect the
 * supervisor already fires when the app comes back to the foreground. Timing
 * something that already exists is what keeps this out of the four append-only
 * lists a new WS RPC method would have to touch, and it measures the real
 * socket rather than a parallel HTTP path that would read healthy while the
 * socket is down.
 *
 * Nothing here polls on its own schedule: the atom family is subscribed by the
 * connections dropdown, so measurement starts when the dropdown opens and the
 * short idle TTL stops it shortly after it closes. A dropdown nobody opened
 * costs no traffic.
 */
import type { EnvironmentId } from "@starcode/contracts";
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentSupervisor } from "@starcode/client-runtime/connection";
import { runInEnvironment } from "@starcode/client-runtime/state/runtime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Long enough that a genuinely slow machine still reports a number, short
 * enough that a hung socket resolves to "no answer" within one refresh. The
 * supervisor's own probe budget is 15s, which is a reconnect decision; this is
 * only a displayed number, so it gives up sooner.
 */
const CONNECTION_PING_TIMEOUT = "8 seconds";

/** How often a mounted (open) dropdown re-measures. */
export const CONNECTION_PING_REFRESH_INTERVAL_MS = 30_000;

/**
 * How long a measurement survives after the dropdown closes. Short on purpose:
 * a ping is worth showing only while someone is looking at it, and a stale one
 * is worse than none. It is not zero so that closing and reopening the
 * dropdown shows the last number instead of a blank while the first sample
 * lands.
 */
const CONNECTION_PING_IDLE_TTL_MS = 20_000;

/**
 * Times one probe round trip, resolving to `null` rather than failing when the
 * probe errors or never answers — a connection that cannot be measured is a
 * state to render, not an error to surface.
 *
 * Exported for tests: the probe is passed in so the measurement can be
 * exercised without standing up a supervisor and a socket.
 */
export const measureProbeRoundTrip = <E>(
  probe: Effect.Effect<void, E, never>,
): Effect.Effect<number | null> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* probe.pipe(
      Effect.timeoutOrElse({
        duration: CONNECTION_PING_TIMEOUT,
        orElse: () => Effect.fail("timeout" as const),
      }),
      Effect.flatMap(() => Clock.currentTimeMillis),
      // Clamp: a clock that steps backwards mid-measurement should read as
      // instant, never as a negative latency.
      Effect.map((completedAt) => Math.max(0, completedAt - startedAt)),
      Effect.catchCause(() => Effect.succeed(null)),
    );
  });

/**
 * `null` means there is nothing to measure — no live session, so the row shows
 * its connection phase instead of a number.
 *
 * No warm-up sample is discarded, and the reason is worth stating because the
 * probe does close over a cached `initialConfig`: the supervisor only publishes
 * a session after the driver has awaited `session.ready`
 * (`connection/driver.ts:57`), which resolves that cache. Every probe reachable
 * from here is therefore exactly one round trip.
 */
const measureConnectionPing: Effect.Effect<number | null, never, EnvironmentSupervisor> =
  Effect.gen(function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const session = yield* SubscriptionRef.get(supervisor.session);
    if (Option.isNone(session)) return null;
    return yield* measureProbeRoundTrip(session.value.probe);
  });

const pingAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(runInEnvironment(environmentId, measureConnectionPing))
    .pipe(
      Atom.setIdleTTL(CONNECTION_PING_IDLE_TTL_MS),
      Atom.withRefresh(CONNECTION_PING_REFRESH_INTERVAL_MS),
      Atom.withLabel(`environment-ping:${environmentId}`),
    ),
);

export interface ConnectionPingSample {
  /** Round-trip milliseconds, or null for "no live session to measure". */
  readonly rttMs: number | null;
  /** True until the first sample of this environment lands. */
  readonly isPending: boolean;
}

const PENDING_SAMPLE: ConnectionPingSample = { rttMs: null, isPending: true };

const EMPTY_PINGS: ReadonlyMap<EnvironmentId, ConnectionPingSample> = new Map();

function samplesEqual(
  left: ReadonlyMap<EnvironmentId, ConnectionPingSample>,
  right: ReadonlyMap<EnvironmentId, ConnectionPingSample>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    const other = right.get(key);
    if (other === undefined) return false;
    if (other.rttMs !== value.rttMs || other.isPending !== value.isPending) return false;
  }
  return true;
}

/**
 * Every catalogued machine's latency in one map, mirroring
 * `environmentUsageSnapshotsAtom`. Fanning out inside an atom rather than
 * inside the component is what lets the machine count change without the
 * dropdown changing its hook count.
 *
 * Reading this atom is what starts the probing, and dropping it is what stops
 * it — see `useConnectionPings`.
 */
export const environmentPingsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, ConnectionPingSample>> =
  (() => {
    let previous = EMPTY_PINGS;
    return Atom.make((get) => {
      const next = new Map<EnvironmentId, ConnectionPingSample>();
      for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
        const result = get(pingAtom(environmentId));
        next.set(
          environmentId,
          Option.match(AsyncResult.value(result), {
            onNone: () => PENDING_SAMPLE,
            onSome: (rttMs) => ({ rttMs, isPending: result.waiting }),
          }),
        );
      }
      if (samplesEqual(previous, next)) return previous;
      previous = next;
      return previous;
    }).pipe(Atom.withLabel("environment-pings"));
  })();

const EMPTY_PINGS_ATOM = Atom.make(EMPTY_PINGS).pipe(Atom.withLabel("environment-pings:idle"));

/**
 * Pass `active: false` to measure nothing at all. Subscribing is what starts
 * the probing, so a closed dropdown must not read the live atom — four
 * machines pinged every 30 seconds for a panel nobody opened is exactly the
 * background chatter this feature is supposed to avoid.
 */
export function useConnectionPings(
  active: boolean,
): ReadonlyMap<EnvironmentId, ConnectionPingSample> {
  return useAtomValue(active ? environmentPingsAtom : EMPTY_PINGS_ATOM);
}
