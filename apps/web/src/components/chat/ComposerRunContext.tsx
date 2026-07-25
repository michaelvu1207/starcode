/**
 * Fork-owned: the "where does this thread run" cluster — machine, workspace,
 * pull request, branch — in the composer's footer.
 *
 * Upstream renders these as a strip glued beneath the composer, with its own
 * glass chrome, which reads as a second bar. The fork briefly gave them the
 * thread header instead; that header is now gone, so they sit inline in the
 * footer row the composer already had, beside the Build/Plan controls they
 * belong with: all four answer "what happens when I press send".
 *
 * The controls themselves are still upstream's `BranchToolbar` — only the
 * chrome and the popup direction change, so upstream fixes to the environment
 * / workspace / branch pickers still land here. Its `layout="composer"` branch
 * and the `.chat-composer-context-strip` styles it needs are left intact even
 * though nothing in the fork renders them: keeping upstream's markup
 * byte-identical is what makes those merges apply cleanly.
 *
 * @module ComposerRunContext
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { memo } from "react";

import type { DraftId } from "~/composerDraftStore";
import { BranchToolbar } from "../BranchToolbar";
import type { EnvMode, EnvironmentOption } from "../BranchToolbar.logic";

export interface ComposerRunContextProps {
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

export const ComposerRunContext = memo(function ComposerRunContext({
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
}: ComposerRunContextProps) {
  return (
    <div className="flex min-w-0 shrink-0 items-center">
      <BranchToolbar
        layout="inline"
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
