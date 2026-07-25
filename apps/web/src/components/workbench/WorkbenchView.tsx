/**
 * Fork-owned: the Workbench.
 *
 * Two regions, in the order an operator reads them: the orchestrator they talk
 * to, and the sky holding everything it has going. The sky is derived entirely
 * from state the client already holds or polls per machine — nothing here asks
 * an agent how it is doing.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ScopedProjectRef,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadActivities, useThreadShell } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import type { StarMapMaster } from "./StarMap.model";
import {
  collectMasterCreatedThreadIds,
  resolveWorkbenchMaster,
  type WorkbenchMasterDesignation,
} from "./Workbench.master";
import { WorkbenchMasterPane } from "./WorkbenchMasterPane";
import { WorkbenchStarMap } from "./WorkbenchStarMap";

export function WorkbenchView() {
  const router = useRouter();
  const { environments } = useEnvironments();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const updateServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "workbench master designation",
  );
  const handleNewThread = useNewThreadHandler();
  const [picking, setPicking] = useState(false);
  const [preferredEnvironmentId, setPreferredEnvironmentId] = useState<EnvironmentId | null>(null);

  const { designated, alternates } = useMemo(() => {
    const candidates = environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      masterThreadId:
        serverConfigs.get(environment.environmentId)?.settings.workbenchMasterThreadId ?? "",
      // A machine the operator explicitly switched to outranks the local one:
      // the pane must not snap back to the local master the moment its data
      // refreshes.
      isLocal:
        preferredEnvironmentId === null
          ? environment.environmentId === primaryEnvironmentId
          : environment.environmentId === preferredEnvironmentId,
    }));
    return resolveWorkbenchMaster(candidates);
  }, [environments, preferredEnvironmentId, primaryEnvironmentId, serverConfigs]);

  const masterThreadRef = useMemo(
    () =>
      designated === null
        ? null
        : scopeThreadRef(
            EnvironmentId.make(designated.environmentId),
            ThreadId.make(designated.threadId),
          ),
    [designated],
  );
  const masterThreadKey = masterThreadRef === null ? null : scopedThreadKey(masterThreadRef);

  // The master's own transcript is the only record of what it started, so the
  // board's tag is only as complete as what this pane has loaded. That is the
  // honest bound of the mechanism, not a bug to paper over.
  const masterActivities = useThreadActivities(masterThreadRef);
  const masterCreatedThreadIds = useMemo(
    () => collectMasterCreatedThreadIds(masterActivities),
    [masterActivities],
  );

  // The orchestrator hangs in the sky as the moon rather than as one more star,
  // so it needs its own name and machine — the map never sees it as a thread.
  const masterShell = useThreadShell(masterThreadRef);
  const starMapMaster = useMemo((): StarMapMaster | null => {
    if (designated === null || masterThreadKey === null) return null;
    return {
      key: masterThreadKey,
      threadId: designated.threadId,
      environmentId: designated.environmentId,
      machineLabel: designated.label,
      title: masterShell?.title ?? "Orchestrator",
      alive: masterShell?.latestTurn?.completedAt === null,
    };
  }, [designated, masterShell, masterThreadKey]);

  const patchSettings = useCallback(
    (environmentId: EnvironmentId, patch: ServerSettingsPatch) => {
      void updateServerSettings({ environmentId, input: { patch } });
    },
    [updateServerSettings],
  );

  const designate = useCallback(
    (environmentId: EnvironmentId, threadId: string) => {
      patchSettings(environmentId, { workbenchMasterThreadId: threadId });
      setPreferredEnvironmentId(environmentId);
      setPicking(false);
    },
    [patchSettings],
  );

  const clearDesignation = useCallback(() => {
    if (designated === null) return;
    patchSettings(EnvironmentId.make(designated.environmentId), { workbenchMasterThreadId: "" });
    setPicking(false);
  }, [designated, patchSettings]);

  const selectAlternate = useCallback((alternate: WorkbenchMasterDesignation) => {
    setPreferredEnvironmentId(EnvironmentId.make(alternate.environmentId));
    setPicking(false);
  }, []);

  /**
   * Creating a master runs the app's ordinary new-thread flow and then claims
   * the id it reserved. The draft is not a thread on the server until its first
   * message, so designating the reserved id here is what makes the pane pick it
   * up the moment it becomes one — no second step to forget.
   */
  const createMaster = useCallback(
    async (projectRef: ScopedProjectRef) => {
      const environmentSettings = serverConfigs.get(projectRef.environmentId)?.settings;
      await handleNewThread(projectRef);
      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const target = resolveThreadRouteTarget(params);
      if (target?.kind !== "draft") return;
      const store = useComposerDraftStore.getState();
      const draft = store.getDraftThread(target.draftId);
      if (draft === null) return;
      // The plan/approval default is configuration, not prompt text: an
      // orchestrator that delegates should not be able to write code, and
      // saying so in settings holds regardless of what is typed into it.
      store.setRuntimeMode(
        target.draftId,
        environmentSettings?.workbenchMasterDefaults.runtimeMode ?? "approval-required",
      );
      store.setInteractionMode(
        target.draftId,
        environmentSettings?.workbenchMasterDefaults.interactionMode ?? "plan",
      );
      designate(projectRef.environmentId, draft.threadId);
    },
    [designate, handleNewThread, router, serverConfigs],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden xl:flex-row">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-b border-border/60 xl:w-[30rem] xl:flex-none xl:border-b-0 xl:border-r">
        <WorkbenchMasterPane
          designation={designated}
          alternates={alternates}
          picking={picking}
          onTogglePicking={() => setPicking((current) => !current)}
          onSelectAlternate={selectAlternate}
          onDesignate={designate}
          onCreate={(projectRef) => void createMaster(projectRef)}
          onClear={clearDesignation}
        />
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <WorkbenchStarMap
          masterThreadKey={masterThreadKey}
          master={starMapMaster}
          masterCreatedThreadIds={masterCreatedThreadIds}
        />
      </div>
    </div>
  );
}
