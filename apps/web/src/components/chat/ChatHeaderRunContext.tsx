/**
 * Fork-owned: the thread header's run-context cluster.
 *
 * Upstream renders this as a strip glued beneath the composer. The fork moves it
 * into the thread header, so the composer is the bottom-most element of the chat
 * pane and "where this thread runs" reads alongside the thread name instead of
 * hiding under the input. The controls themselves are still upstream's
 * `BranchToolbar` — only the chrome and the popup direction change, so upstream
 * fixes to the environment / workspace / branch pickers still land here. Its
 * `layout="composer"` branch and the `.chat-composer-context-strip` styles it
 * needs are left intact even though nothing in the fork renders them: keeping
 * upstream's markup byte-identical is what makes those merges apply cleanly.
 *
 * The wrapper carries the rule that separates the cluster from the thread title.
 * `empty:hidden` retires it along with the toolbar: `BranchToolbar` renders
 * nothing for a project it cannot resolve, and an orphan rule would be worse
 * than no rule.
 *
 * @module ChatHeaderRunContext
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo } from "react";

import type { DraftId } from "~/composerDraftStore";
import { BranchToolbar } from "../BranchToolbar";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";

export interface ChatHeaderRunContextProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId?: DraftId;
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
  readonly onEnvironmentChange?: (environmentId: EnvironmentId) => void;
}

export const ChatHeaderRunContext = memo(function ChatHeaderRunContext({
  environmentId,
  threadId,
  draftId,
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
  onEnvironmentChange,
}: ChatHeaderRunContextProps) {
  // No inline padding on the rule: the toolbar's own controls carry theirs, and
  // adding more here pushes the rule off-centre against the title-side gap.
  return (
    <div className="flex min-w-0 shrink-0 items-center border-l border-border/60 empty:hidden">
      <BranchToolbar
        layout="header"
        environmentId={environmentId}
        threadId={threadId}
        {...(draftId ? { draftId } : {})}
        envLocked={envLocked}
        {...(effectiveEnvModeOverride ? { effectiveEnvModeOverride } : {})}
        {...(activeThreadBranchOverride !== undefined ? { activeThreadBranchOverride } : {})}
        {...(onActiveThreadBranchOverrideChange ? { onActiveThreadBranchOverrideChange } : {})}
        startFromOrigin={startFromOrigin}
        onStartFromOriginChange={onStartFromOriginChange}
        onEnvModeChange={onEnvModeChange}
        {...(onCheckoutPullRequestRequest ? { onCheckoutPullRequestRequest } : {})}
        {...(onComposerFocusRequest ? { onComposerFocusRequest } : {})}
        {...(onEnvironmentChange ? { onEnvironmentChange } : {})}
        {...(availableEnvironments ? { availableEnvironments } : {})}
      />
    </div>
  );
});
