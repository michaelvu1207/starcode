/**
 * Provider glyph for a terminal-history row.
 *
 * Deliberately not `ProviderInstanceIcon`: that one is keyed on a configured
 * provider *instance* and carries a badge, status dot, and accent colour. A
 * history session belongs to no instance — it is a file the CLI wrote, found
 * by path — so all that is wanted here is the mark, using the same icons the
 * rest of the app uses so Claude and Codex read identically everywhere.
 */
import type { AgentRunProvider, HistoryProvider } from "@starcode/contracts";
import type { ReactNode } from "react";

import { ClaudeAI, OpenAI } from "../Icons";

export function HistoryProviderIcon(props: {
  readonly provider: HistoryProvider | AgentRunProvider;
  readonly className?: string;
}): ReactNode {
  const Icon = props.provider === "claude" || props.provider === "claudeAgent" ? ClaudeAI : OpenAI;
  return <Icon aria-hidden className={props.className} />;
}

export const historyProviderLabel = (provider: HistoryProvider | AgentRunProvider): string => {
  if (provider === "claude" || provider === "claudeAgent") return "Claude Code";
  if (provider === "codex") return "Codex";
  if (provider === "pi") return "Pi";
  if (provider === "opencode") return "OpenCode (legacy)";
  if (provider === "cursor") return "Cursor";
  if (provider === "grok") return "Grok";
  return String(provider);
};
