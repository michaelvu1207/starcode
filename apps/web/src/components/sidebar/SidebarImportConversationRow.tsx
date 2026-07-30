/**
 * The one door from a connection group into the import picker.
 *
 * This replaced the terminal-history strip. That strip listed the CLI sessions
 * a machine had and let you read one; starcode no longer reads old
 * conversations, it resumes them, so a browsable list of things you cannot act
 * on was sidebar weight with no destination. What is left is the action itself.
 *
 * Deliberately hookless and prop-only, so it can be called directly in a test
 * and so the picker's arrival in F12 phase 4 changes `openImportPicker` and
 * nothing here. Styled as the same dashed affordance as "Show N more" — both
 * are "there is more, go get it" rather than content.
 */
import type { EnvironmentId } from "@starcode/contracts";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";

import { openImportPicker } from "./importPicker";

export function SidebarImportConversationRow(props: {
  readonly environmentId: EnvironmentId;
}): ReactNode {
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => openImportPicker(props.environmentId)}
        data-testid="sidebar-v2-import-conversation"
        data-environment-id={props.environmentId}
        className="mt-1 flex h-[30px] w-full cursor-pointer items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-[11px] text-muted-foreground transition-colors hover:border-solid hover:border-input hover:bg-background/45 hover:text-foreground dark:border-white/15 dark:hover:border-white/30 dark:hover:bg-transparent"
      >
        <DownloadIcon aria-hidden className="size-3 shrink-0" />
        Import conversation…
      </button>
    </li>
  );
}
