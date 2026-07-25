/**
 * One line saying where an imported thread came from.
 *
 * An imported thread opens with an empty transcript that the model remembers
 * every word of — hundreds of messages of context behind a view that looks
 * brand new. That surprise is the one real hazard of the import feature, and
 * this line is what defuses it: *Resumed from a Claude Code terminal session ·
 * 483 messages · Jul 12*.
 *
 * Non-interactive on purpose. There is nowhere to go: starcode deleted the
 * history viewer, so a link would lead to a page that no longer exists. It
 * states a fact and gets out of the way.
 *
 * Renders nothing at all for ordinary threads, and nothing on a machine whose
 * server predates the import registry — the fork's whole ChatView diff is one
 * unconditional element, and every "should this appear?" decision lives here
 * rather than in the repo's hottest file.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useHistoryImports } from "~/state/terminalHistory";
import {
  findHistoryImportForThread,
  formatImportPreludeLine,
} from "../history/ImportConversationDialog.logic";
import { HistoryProviderIcon } from "../sidebar/HistoryProviderIcon";

export function ImportedThreadPrelude(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ReactNode {
  // Cached per machine and shared with the picker, so opening a thread costs
  // no request of its own once either surface has read the registry.
  const imports = useHistoryImports(props.environmentId);
  const record = findHistoryImportForThread(imports.data?.imports ?? null, props.threadId);
  if (record === null) return null;
  return (
    <p
      data-testid="imported-thread-prelude"
      className="flex shrink-0 items-center justify-center gap-1.5 px-4 py-1.5 text-[11px] text-muted-foreground/70"
    >
      <HistoryProviderIcon provider={record.provider} className="size-3 shrink-0 opacity-60" />
      {formatImportPreludeLine({
        provider: record.provider,
        messageCount: record.messageCount,
        startedAt: record.startedAt,
      })}
    </p>
  );
}
