/**
 * Fork-owned: the pane's run context and panel toggles, behind one glyph in the
 * composer footer.
 *
 * These used to sit in the thread header, which the fork removed so the chat
 * pane is transcript and composer edge to edge. None of them is touched
 * mid-thread — you pick a workspace and a branch before the first turn, and
 * both panel toggles have keybindings that stay the fast path — so a persistent
 * bar was a poor trade for a handful of controls.
 *
 * Workspace and Branch moved in here from the footer's inline row, which is why
 * that row now carries only the machine indicator: those two are the *pre-flight*
 * decisions, read far more often than they are changed, and a strip that showed
 * them permanently spent a line of chrome on state a tooltip can answer.
 *
 * "Open in" and "Actions" (project scripts) used to live here and are gone —
 * along with their plumbing. See `ChatView` for what went with them.
 *
 * @module ComposerPaneMenu
 */
import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ThreadId,
} from "@starcode/contracts";
import { EllipsisIcon } from "lucide-react";
import { memo } from "react";

import type { DraftId } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import { BranchToolbar } from "../BranchToolbar";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerOptionRow } from "./ComposerOptionsPopover";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./PanelLayoutControls";
import { SplitPaneMenuControls } from "../split/SplitPaneMenuControls";
import { deriveLatestTokensPerSecond, formatTokensPerSecond } from "../../lib/contextWindow";

export interface ComposerPaneMenuProps {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadActivities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly activeLatestTurn: OrchestrationLatestTurn | null;
  readonly threadId: ThreadId;
  readonly draftId?: DraftId;
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
  /** Run context — the same props `ComposerRunContext` used to forward. */
  readonly envLocked: boolean;
  readonly effectiveEnvModeOverride?: EnvMode;
  readonly activeThreadBranchOverride?: string | null;
  readonly startFromOrigin: boolean;
  readonly availableEnvironments?: readonly EnvironmentOption[];
  readonly onEnvModeChange: (mode: EnvMode) => void;
  readonly onActiveThreadBranchOverrideChange?: (branch: string | null) => void;
  readonly onStartFromOriginChange: (startFromOrigin: boolean) => void;
  readonly onCheckoutPullRequestRequest?: (reference: string) => void;
  readonly onComposerFocusRequest?: () => void;
}

export const ComposerPaneMenu = memo(function ComposerPaneMenu({
  activeThreadEnvironmentId,
  activeThreadActivities,
  activeLatestTurn,
  threadId,
  draftId,
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
  envLocked,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  startFromOrigin,
  availableEnvironments,
  onEnvModeChange,
  onActiveThreadBranchOverrideChange,
  onStartFromOriginChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: ComposerPaneMenuProps) {
  const tokensPerSecond = formatTokensPerSecond(
    deriveLatestTokensPerSecond(activeThreadActivities, { latestTurn: activeLatestTurn }),
  );

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
        // Branch names vary a lot; a fixed width clips them against the
        // viewport's overflow-clip.
        className="!w-auto min-w-64 max-w-[min(26rem,calc(100vw-2rem))]"
        viewportClassName="py-3"
      >
        <div className="grid gap-2.5">
          {/* Workspace and branch lead: they answer "what does send actually
              touch", which is the question you open this menu to check. */}
          <ComposerOptionRow label="Workspace" hint="Checkout and branch">
            <BranchToolbar
              layout="menu"
              environmentId={activeThreadEnvironmentId}
              threadId={threadId}
              {...(draftId ? { draftId } : {})}
              envLocked={envLocked}
              {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
              {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
              {...(onActiveThreadBranchOverrideChange
                ? { onActiveThreadBranchOverrideChange }
                : {})}
              startFromOrigin={startFromOrigin}
              onStartFromOriginChange={onStartFromOriginChange}
              onEnvModeChange={onEnvModeChange}
              {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
              {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
              {...(availableEnvironments ? { availableEnvironments } : {})}
            />
          </ComposerOptionRow>

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

          {tokensPerSecond ? (
            <>
              <div className="border-border/60 border-t" />
              <ComposerOptionRow label="Tokens per second">
                <span
                  data-chat-composer-tokens-per-second="true"
                  className="font-medium text-muted-foreground text-xs tabular-nums"
                >
                  {tokensPerSecond}
                </span>
              </ComposerOptionRow>
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
