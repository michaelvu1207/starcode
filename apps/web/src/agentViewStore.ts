/**
 * Which subagent, if any, the user is reading instead of a thread's own
 * transcript.
 *
 * Scoped per thread so switching threads and coming back does not lose your
 * place, and deliberately **not persisted**: a subagent is transient by nature,
 * and restoring a selection for an agent that finished while the app was closed
 * would open an empty view with no obvious way back. On reload you land on the
 * main thread, which is always a valid place to be.
 *
 * A provider is part of the identity: Claude and Codex may reuse the same
 * lifecycle id under one parent, and selecting one must never open the other.
 */
import { scopedThreadKey } from "@starcode/client-runtime/environment";
import type { AgentRun, ScopedThreadRef } from "@starcode/contracts";
import { create } from "zustand";

export type SelectedAgentRun = Pick<AgentRun, "provider" | "agentRunId">;

interface AgentViewStoreState {
  readonly selectedAgentRunByThreadKey: Readonly<Record<string, SelectedAgentRun>>;
  readonly select: (ref: ScopedThreadRef, run: SelectedAgentRun) => void;
  readonly clear: (ref: ScopedThreadRef) => void;
}

export const useAgentViewStore = create<AgentViewStoreState>((set) => ({
  selectedAgentRunByThreadKey: {},
  select: (ref, run) =>
    set((state) => ({
      selectedAgentRunByThreadKey: {
        ...state.selectedAgentRunByThreadKey,
        [scopedThreadKey(ref)]: run,
      },
    })),
  clear: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!(key in state.selectedAgentRunByThreadKey)) {
        return state;
      }
      const { [key]: _removed, ...rest } = state.selectedAgentRunByThreadKey;
      return { selectedAgentRunByThreadKey: rest };
    }),
}));

/** The agent selected for a thread, or null when its own transcript is shown. */
export function useSelectedAgentRun(ref: ScopedThreadRef | null): SelectedAgentRun | null {
  return useAgentViewStore((state) =>
    ref === null ? null : (state.selectedAgentRunByThreadKey[scopedThreadKey(ref)] ?? null),
  );
}
