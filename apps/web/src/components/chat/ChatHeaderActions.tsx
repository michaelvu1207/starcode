/**
 * Fork-owned: the right-hand action cluster of the thread header.
 *
 * Extracted from `ChatHeader.tsx` so the fork's header edits stay a single
 * call site in that upstream file (34 touches / 500 commits). Upstream's
 * `GitActionsControl` split button is deliberately not rendered here — the
 * fork drives commits from the terminal, and the header reads much quieter
 * with one action in the corner. The control itself is untouched, so
 * restoring it is a one-line change.
 *
 * @module ChatHeaderActions
 */
import { type EditorId, type EnvironmentId, type ProjectScript } from "@t3tools/contracts";
import { type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import type { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";

export interface ChatHeaderActionsProps {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  readonly fileScripts: ReturnType<typeof useT3ProjectFileScripts>;
  readonly preferredScriptId: string | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly openInCwd: string | null;
  readonly showOpenInPicker: boolean;
  readonly rightPanelOpen: boolean;
  readonly onRunProjectScript: (script: ProjectScript) => void;
  readonly onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  readonly onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  readonly onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export const ChatHeaderActions = memo(function ChatHeaderActions({
  activeThreadEnvironmentId,
  activeProjectScripts,
  fileScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  openInCwd,
  showOpenInPicker,
  rightPanelOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderActionsProps) {
  return (
    <div
      data-chat-header-actions
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
        rightPanelOpen ? "pr-0" : "pr-16",
      )}
    >
      {showOpenInPicker && (
        <OpenInPicker
          environmentId={activeThreadEnvironmentId}
          keybindings={keybindings}
          availableEditors={availableEditors}
          openInCwd={openInCwd}
        />
      )}
      {activeProjectScripts && (
        <ProjectScriptsControl
          scripts={activeProjectScripts}
          fileScripts={fileScripts}
          keybindings={keybindings}
          preferredScriptId={preferredScriptId}
          onRunScript={onRunProjectScript}
          onAddScript={onAddProjectScript}
          onUpdateScript={onUpdateProjectScript}
          onDeleteScript={onDeleteProjectScript}
        />
      )}
    </div>
  );
});
