/**
 * Where an imported or forked thread's conversation came from.
 *
 * Such a thread opens with an empty transcript that the model remembers every
 * word of — hundreds of messages of context behind a view that looks brand
 * new. That surprise is the one real hazard of resuming a foreign session, and
 * this is what defuses it.
 *
 * It does so at two depths. When the machine can address the session behind the
 * thread, the line is a disclosure: *Earlier conversation · 483 messages ·
 * Jul 12 – Jul 26 · from Claude Code on simforge1*, opening onto the
 * conversation itself, paged and read-only. When it cannot — a fork whose
 * source file the index never found, a registry row written before the
 * boundary existed, a server too old to serve pages — it degrades to the
 * non-interactive line F12 shipped, which still states the fact.
 *
 * Renders nothing at all for ordinary threads, and nothing on a machine that
 * cannot say. **The fork's whole `ChatView.tsx` diff is one unconditional
 * element**, unchanged by this: every "should this appear, and as what?"
 * decision lives here rather than in the repo's hottest file.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useEnvironments } from "~/state/environments";
import { useHistoryImports } from "~/state/terminalHistory";
import { formatImportPreludeLine } from "../history/ImportConversationDialog.logic";
import { HistoryProviderIcon } from "../sidebar/HistoryProviderIcon";
import { buildThreadHistoryModel, resolveThreadProvenance } from "./ThreadHistory.logic";
import { ThreadHistorySection } from "./ThreadHistorySection";

export function ImportedThreadPrelude(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ReactNode {
  // Cached per machine and shared with the picker, so opening a thread costs
  // no request of its own once either surface has read the registry. This is
  // also why the collapsed section is free: its summary is already here.
  const imports = useHistoryImports(props.environmentId);
  // The machine this thread lives on, by the name its owner gave it. A thread
  // resumed from a session on another box is the case the whole fleet exists
  // for, and "from Claude Code" without saying where is half an answer.
  const { environments } = useEnvironments();
  const machineLabel =
    environments.find((environment) => environment.environmentId === props.environmentId)?.label ??
    null;

  const provenance = resolveThreadProvenance({
    imports: imports.data?.imports ?? null,
    forks: imports.data?.forks ?? null,
    threadId: props.threadId,
  });
  if (provenance === null) return null;

  const model = buildThreadHistoryModel({ provenance, machineLabel });
  if (model.sessionId !== null) {
    return (
      <ThreadHistorySection
        environmentId={props.environmentId}
        model={model}
        sessionId={model.sessionId}
      />
    );
  }
  return (
    <p
      data-testid="imported-thread-prelude"
      className="flex shrink-0 items-center justify-center gap-1.5 px-4 py-1.5 text-[11px] text-muted-foreground/70"
    >
      <HistoryProviderIcon provider={model.provider} className="size-3 shrink-0 opacity-60" />
      {provenance.kind === "imported"
        ? formatImportPreludeLine({
            provider: provenance.record.provider,
            messageCount: provenance.record.messageCount,
            startedAt: provenance.record.startedAt,
          })
        : `Forked conversation · ${model.summary}`}
    </p>
  );
}
