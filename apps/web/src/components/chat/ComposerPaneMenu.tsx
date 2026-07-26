/**
 * Fork-owned: the pane's workspace actions and panel toggles, behind one glyph
 * in the composer footer.
 *
 * These used to sit in the thread header, which the fork removed so the chat
 * pane is transcript and composer edge to edge. None of them is touched
 * mid-thread — you open an editor or run a project script between turns, and
 * both panel toggles have keybindings that stay the fast path — so a
 * persistent bar was a poor trade for four controls. They keep their own
 * components, so upstream fixes to the editor list or the script dialogs still
 * land here.
 *
 * @module ComposerPaneMenu
 */
import {
  type EditorId,
  type EnvironmentId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";
import { memo } from "react";

import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { cn } from "~/lib/utils";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerOptionRow } from "./ComposerOptionsPopover";
import { OpenInPicker } from "./OpenInPicker";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./PanelLayoutControls";
import { SplitPaneMenuControls } from "../split/SplitPaneMenuControls";

/**
 * "Open in editor" shells out on the machine running the server, so it is only
 * meaningful for projects on the environment this client is hosted by.
 */
export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export interface ComposerPaneMenuProps {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeProjectName: string | undefined;
  readonly activeProjectCwd: string | null;
  readonly openInCwd: string | null;
  readonly activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  readonly preferredScriptId: string | null;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly terminalAvailable: boolean;
  readonly terminalOpen: boolean;
  readonly terminalShortcutLabel: string | null;
  readonly rightPanelAvailable: boolean;
  readonly rightPanelOpen: boolean;
  readonly rightPanelShortcutLabel: string | null;
  readonly showRightPanelMaximize: boolean;
  readonly rightPanelMaximized: boolean;
  readonly onToggleTerminal: () => void;
  readonly onToggleRightPanel: () => void;
  readonly onToggleRightPanelMaximized: () => void;
  readonly onRunProjectScript: (script: ProjectScript) => void;
  readonly onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  readonly onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  readonly onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export const ComposerPaneMenu = memo(function ComposerPaneMenu({
  activeThreadEnvironmentId,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalShortcutLabel,
  rightPanelAvailable,
  rightPanelOpen,
  rightPanelShortcutLabel,
  showRightPanelMaximize,
  rightPanelMaximized,
  onToggleTerminal,
  onToggleRightPanel,
  onToggleRightPanelMaximized,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ComposerPaneMenuProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  data-chat-composer-pane-trigger="true"
                  aria-label="Workspace and panels"
                  className={cn(
                    "shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80",
                    "data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
                  )}
                />
              }
            >
              <EllipsisIcon aria-hidden="true" className="size-3.5" />
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="top">Workspace and panels</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={8}
        data-chat-composer-pane-popup="true"
        // Editor names and script names both vary a lot; a fixed width clips
        // them against the viewport's overflow-clip.
        className="!w-auto min-w-64 max-w-[min(26rem,calc(100vw-2rem))]"
        viewportClassName="py-3"
      >
        <div className="grid gap-2.5">
          {showOpenInPicker ? (
            <ComposerOptionRow label="Open in">
              <OpenInPicker
                environmentId={activeThreadEnvironmentId}
                keybindings={keybindings}
                availableEditors={availableEditors}
                openInCwd={openInCwd}
              />
            </ComposerOptionRow>
          ) : null}

          {activeProjectScripts ? (
            <ComposerOptionRow label="Actions" hint="Project scripts">
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
            </ComposerOptionRow>
          ) : null}

          <ComposerOptionRow label="Split" hint="Two threads at once">
            <SplitPaneMenuControls />
          </ComposerOptionRow>

          <ComposerOptionRow label="Panels">
            <div className="flex items-center gap-1">
              {showRightPanelMaximize ? (
                <RightPanelMaximizeControl
                  maximized={rightPanelMaximized}
                  onToggle={onToggleRightPanelMaximized}
                />
              ) : null}
              <PanelLayoutControls
                terminalAvailable={terminalAvailable}
                terminalOpen={terminalOpen}
                terminalShortcutLabel={terminalShortcutLabel}
                rightPanelAvailable={rightPanelAvailable}
                rightPanelOpen={rightPanelOpen}
                rightPanelShortcutLabel={rightPanelShortcutLabel}
                onToggleTerminal={onToggleTerminal}
                onToggleRightPanel={onToggleRightPanel}
              />
            </div>
          </ComposerOptionRow>
        </div>
      </PopoverPopup>
    </Popover>
  );
});
