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
 * Keyed by task id rather than tool-use id because the task id is what every
 * `task.*` activity carries; the tool-use id is resolved from the shell's
 * subagent rollup at the point of use.
 */
import { scopedThreadKey } from "@starcode/client-runtime/environment";
import type { ScopedThreadRef } from "@starcode/contracts";
import { create } from "zustand";

interface AgentViewStoreState {
  readonly selectedTaskIdByThreadKey: Readonly<Record<string, string>>;
  readonly select: (ref: ScopedThreadRef, taskId: string) => void;
  readonly clear: (ref: ScopedThreadRef) => void;
}

export const useAgentViewStore = create<AgentViewStoreState>((set) => ({
  selectedTaskIdByThreadKey: {},
  select: (ref, taskId) =>
    set((state) => ({
      selectedTaskIdByThreadKey: {
        ...state.selectedTaskIdByThreadKey,
        [scopedThreadKey(ref)]: taskId,
      },
    })),
  clear: (ref) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      if (!(key in state.selectedTaskIdByThreadKey)) {
        return state;
      }
      const { [key]: _removed, ...rest } = state.selectedTaskIdByThreadKey;
      return { selectedTaskIdByThreadKey: rest };
    }),
}));

/** The agent selected for a thread, or null when its own transcript is shown. */
export function useSelectedAgentTaskId(ref: ScopedThreadRef | null): string | null {
  return useAgentViewStore((state) =>
    ref === null ? null : (state.selectedTaskIdByThreadKey[scopedThreadKey(ref)] ?? null),
  );
}
