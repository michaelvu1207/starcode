import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { ChatHeaderActions } from "./ChatHeaderActions";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  // `activeThreadId`, `draftId` and `gitCwd` are only consumed by upstream's
  // git split button, which this fork does not render (see ChatHeaderActions).
  // They stay on the interface so the ChatView call site is untouched and
  // restoring the control is a one-line change.
  gitCwd: string | null;
  // Fork: the environment / workspace / branch cluster that upstream renders as
  // a strip under the composer. A node rather than a dozen props, which keeps
  // the wiring at the ChatView call site at the cost of this header's memo.
  // See ChatHeaderRunContext.
  runContext?: ReactNode;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

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

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadTitle,
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  runContext,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
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
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
        {/* Fork: the project breadcrumb used to lead the header. The run context
            answers "which project" better than the name did — it names the
            machine, the checkout and the branch — and the sidebar row still
            carries the project name, so the title leads instead. The title is
            grow-0 so the run context stays tucked against it rather than
            drifting into the action cluster on a wide window. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 shrink truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="bottom">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
        {runContext}
      </div>
      <ChatHeaderActions
        activeThreadEnvironmentId={activeThreadEnvironmentId}
        activeProjectScripts={activeProjectScripts}
        fileScripts={fileScripts}
        preferredScriptId={preferredScriptId}
        keybindings={keybindings}
        availableEditors={availableEditors}
        openInCwd={openInCwd}
        showOpenInPicker={showOpenInPicker}
        rightPanelOpen={rightPanelOpen}
        onRunProjectScript={onRunProjectScript}
        onAddProjectScript={onAddProjectScript}
        onUpdateProjectScript={onUpdateProjectScript}
        onDeleteProjectScript={onDeleteProjectScript}
      />
    </div>
  );
});
