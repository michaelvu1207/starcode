/**
 * The renderer half of Discord rich presence.
 *
 * Presence has to be computed here because this is the only side that sees
 * every connection at once — the desktop main process owns backends, not thread
 * state, and a machine you are connected to over SSH has no main process of its
 * own. What crosses the bridge is counts and nothing else; see
 * `DiscordPresenceSummarySchema` for why that boundary is drawn where it is.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  DesktopBridge,
  DiscordPresenceState,
  DiscordPresenceSummary,
  EnvironmentId,
} from "@starcode/contracts";
import type { SupervisorConnectionState } from "@starcode/client-runtime/connection";
import type { EnvironmentThreadShell } from "@starcode/client-runtime/state/models";
import { useEffect, useRef, useState } from "react";
import { Atom } from "effect/unstable/reactivity";

import { environmentConnectionStatesAtom } from "./connectionStates";
import { environmentThreadShells } from "./threads";

type DiscordPresenceBridge = Pick<
  DesktopBridge,
  | "getDiscordPresenceState"
  | "setDiscordPresenceEnabled"
  | "setDiscordPresenceSummary"
  | "onDiscordPresenceState"
>;

function getDiscordPresenceBridge(): DiscordPresenceBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge;
}

/**
 * A thread the user is the blocker on.
 *
 * Deliberately the same three signals the sidebar's attention badge uses, so
 * "2 threads need attention" on Discord and two badges in the app never
 * disagree.
 */
function needsAttention(shell: EnvironmentThreadShell): boolean {
  return shell.hasPendingApprovals || shell.hasPendingUserInput || shell.hasActionableProposedPlan;
}

export function deriveDiscordPresenceSummary(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly connectionStates: ReadonlyMap<EnvironmentId, SupervisorConnectionState>;
}): DiscordPresenceSummary {
  let runningThreadCount = 0;
  let attentionThreadCount = 0;
  let runningSince: string | null = null;
  let runningSinceMillis = Number.POSITIVE_INFINITY;

  for (const shell of input.threads) {
    // Archived threads keep their last turn forever, so counting them would
    // pin the presence at "3 agents running" for the life of the workspace.
    if (shell.archivedAt !== null) continue;

    if (shell.latestTurn?.state === "running") {
      runningThreadCount += 1;
      // `startedAt` is null between a turn being requested and the provider
      // actually picking it up; the request instant is the honest fallback.
      const startedAt = shell.latestTurn.startedAt ?? shell.latestTurn.requestedAt;
      const millis = Date.parse(startedAt);
      if (Number.isFinite(millis) && millis < runningSinceMillis) {
        runningSinceMillis = millis;
        runningSince = startedAt;
      }
      continue;
    }

    if (needsAttention(shell)) {
      attentionThreadCount += 1;
    }
  }

  let connectedEnvironmentCount = 0;
  for (const state of input.connectionStates.values()) {
    if (state.phase === "connected") connectedEnvironmentCount += 1;
  }

  return {
    runningThreadCount,
    attentionThreadCount,
    connectedEnvironmentCount,
    runningSince,
  };
}

export function discordPresenceSummaryEquals(
  left: DiscordPresenceSummary,
  right: DiscordPresenceSummary,
): boolean {
  return (
    left.runningThreadCount === right.runningThreadCount &&
    left.attentionThreadCount === right.attentionThreadCount &&
    left.connectedEnvironmentCount === right.connectedEnvironmentCount &&
    left.runningSince === right.runningSince
  );
}

export const discordPresenceSummaryAtom: Atom.Atom<DiscordPresenceSummary> = (() => {
  let previous: DiscordPresenceSummary | null = null;
  return Atom.make((get) => {
    const next = deriveDiscordPresenceSummary({
      threads: get(environmentThreadShells.threadShellsAtom),
      connectionStates: get(environmentConnectionStatesAtom),
    });
    if (previous !== null && discordPresenceSummaryEquals(previous, next)) return previous;
    previous = next;
    return previous;
  }).pipe(Atom.withLabel("discord-presence-summary"));
})();

/**
 * Push the current counts down to the main process whenever they change.
 *
 * Mount once, at the app root. No throttling here on purpose — the main
 * process already rate-limits to Discord's budget, and duplicating that policy
 * on both sides of the bridge is how the two get to drift apart.
 */
export function useDiscordPresencePublisher(): void {
  const summary = useAtomValue(discordPresenceSummaryAtom);

  useEffect(() => {
    const bridge = getDiscordPresenceBridge();
    if (bridge?.setDiscordPresenceSummary === undefined) return;
    void bridge.setDiscordPresenceSummary(summary).catch(() => {
      // A presence update is never worth surfacing to the user, and the main
      // process logs its own failures with far more context than we have here.
    });
  }, [summary]);
}

/**
 * Renderless mount point for {@link useDiscordPresencePublisher}.
 *
 * A component rather than a hook call in the root so it sits inside the atom
 * registry provider without the root itself having to subscribe to thread
 * state and re-render on every turn.
 */
export function DiscordPresencePublisher(): null {
  useDiscordPresencePublisher();
  return null;
}

/**
 * The main process's view of the Discord connection, for the settings row.
 *
 * Returns null on the hosted web app and on desktop builds that predate the
 * feature, which is the signal to render nothing at all.
 */
export function useDiscordPresenceState(): DiscordPresenceState | null {
  const [state, setState] = useState<DiscordPresenceState | null>(null);

  // The listener has to be registered before the initial read, or a state
  // change landing between the two would be lost until the next one.
  const latest = useRef<DiscordPresenceState | null>(null);
  useEffect(() => {
    const bridge = getDiscordPresenceBridge();
    if (bridge?.getDiscordPresenceState === undefined) return;

    let cancelled = false;
    const apply = (next: DiscordPresenceState) => {
      if (cancelled) return;
      latest.current = next;
      setState(next);
    };

    const unsubscribe = bridge.onDiscordPresenceState?.(apply);
    void bridge
      .getDiscordPresenceState()
      .then((initial) => {
        // A pushed state is newer than a read that started before it.
        if (latest.current === null) apply(initial);
      })
      .catch(() => {
        // Leaves the row hidden, which is the same as the no-bridge case.
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  return state;
}

export function setDiscordPresenceEnabled(enabled: boolean): Promise<DiscordPresenceState | null> {
  const bridge = getDiscordPresenceBridge();
  if (bridge?.setDiscordPresenceEnabled === undefined) return Promise.resolve(null);
  return bridge.setDiscordPresenceEnabled(enabled);
}
