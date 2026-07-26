/**
 * Fork-owned: the split affordances, as a row in the composer's pane menu.
 *
 * The plan put these in the thread header. The header is gone — it cost 52px
 * for a title the sidebar already shows — and the pane menu is where its
 * controls went, so that is where these belong. It is also rendered *inside*
 * each pane, which means it can read the pane context directly and show the
 * right control for the pane it is in, with no prop drilling.
 *
 * Two panes with two "close split" buttons would be ambiguous about which
 * thread survives, so the second pane gets "Close this pane" instead.
 *
 * @module SplitPaneMenuControls
 */
import { Columns2Icon, ReplaceIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { splitFitsContainer } from "./Split.logic";
import { usePaneId } from "./SplitPaneContext";
import { useSplitStore } from "./splitStore";

function ControlButton({
  label,
  testId,
  disabled = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            aria-label={label}
            data-testid={testId}
            disabled={disabled}
            onClick={onClick}
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export function SplitPaneMenuControls() {
  const paneId = usePaneId();
  const enabled = useSplitStore((state) => state.enabled);
  const containerWidth = useSplitStore((state) => state.containerWidth);
  const openSplit = useSplitStore((state) => state.openSplit);
  const closeSplit = useSplitStore((state) => state.closeSplit);
  const setSecondary = useSplitStore((state) => state.setSecondary);

  if (paneId === "secondary") {
    return (
      <div className="flex items-center gap-1">
        <ControlButton
          label="Choose a different thread"
          testId="split-change-secondary"
          onClick={() => setSecondary(null)}
        >
          <ReplaceIcon aria-hidden="true" className="size-3.5" />
        </ControlButton>
        <ControlButton label="Close this pane" testId="split-close-secondary" onClick={closeSplit}>
          <XIcon aria-hidden="true" className="size-3.5" />
        </ControlButton>
      </div>
    );
  }

  // A silently missing control reads as a bug, so a window too narrow for two
  // panes gets a disabled button that says why rather than no button.
  const fits = containerWidth === null || splitFitsContainer(containerWidth);

  return (
    <div className="flex items-center gap-1">
      <ControlButton
        label={
          enabled
            ? "Close split view"
            : fits
              ? "Open split view"
              : "The window is too narrow for two threads"
        }
        testId="split-toggle"
        disabled={!enabled && !fits}
        onClick={enabled ? closeSplit : openSplit}
      >
        <Columns2Icon aria-hidden="true" className="size-3.5" />
      </ControlButton>
    </div>
  );
}
