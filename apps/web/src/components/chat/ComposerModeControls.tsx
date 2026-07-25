/**
 * Fork-owned: the mode toggles that stay visible on the composer bar.
 *
 * Lifted out of `ChatComposer.tsx`'s `ComposerFooterModeControls`. The
 * runtime-mode ("access") select that used to sit alongside these moved into
 * `ComposerOptionsPopover` — the closed bar now reads prompt → Build/Plan →
 * options chevron → send.
 *
 * @module ComposerModeControls
 */
import { type ProviderInteractionMode } from "@t3tools/contracts";
import { memo } from "react";
import { BotIcon, ListTodoIcon, PencilRulerIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ComposerModeControls = memo(function ComposerModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  showPlanToggle: boolean;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  onToggleInteractionMode: () => void;
  onTogglePlanSidebar: () => void;
}) {
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";
  const planSidebarTooltip = props.planSidebarOpen
    ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
    : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`;

  return (
    <>
      {props.showInteractionModeToggle ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                className={cn(
                  "shrink-0 whitespace-nowrap px-2 sm:px-2.5",
                  props.interactionMode === "plan"
                    ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                    : "text-muted-foreground/70 hover:text-foreground/80",
                )}
                size="sm"
                type="button"
                onClick={props.onToggleInteractionMode}
                aria-label={interactionModeTooltip}
              />
            }
          >
            {props.interactionMode === "plan" ? (
              <PencilRulerIcon className="text-current opacity-100" />
            ) : (
              <BotIcon />
            )}
            <span className="sr-only sm:not-sr-only">
              {props.interactionMode === "plan" ? "Plan" : "Build"}
            </span>
          </TooltipTrigger>
          <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
        </Tooltip>
      ) : null}

      {props.showPlanToggle ? (
        <>
          <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  className={cn(
                    "shrink-0 whitespace-nowrap px-2 sm:px-2.5",
                    props.planSidebarOpen
                      ? "bg-blue-500/10 text-blue-400 hover:bg-blue-500/15 hover:text-blue-300"
                      : "text-muted-foreground/70 hover:text-foreground/80",
                  )}
                  size="sm"
                  type="button"
                  onClick={props.onTogglePlanSidebar}
                  aria-label={planSidebarTooltip}
                />
              }
            >
              <ListTodoIcon
                className={props.planSidebarOpen ? "text-current opacity-100" : undefined}
              />
              <span className="sr-only sm:not-sr-only">{props.planSidebarLabel}</span>
            </TooltipTrigger>
            <TooltipPopup side="top">{planSidebarTooltip}</TooltipPopup>
          </Tooltip>
        </>
      ) : null}
    </>
  );
});
