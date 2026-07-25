/**
 * Fork-owned: the composer's model / effort / access controls, collapsed into
 * one chevron beside the send button.
 *
 * Upstream spreads these across the bottom bar, which makes the composer tall
 * and noisy for a control set that changes rarely. Here the bar keeps only
 * what is touched mid-thread (Build/Plan, send) and everything else lives one
 * click away — with the current state still legible on the trigger, so hidden
 * does not become invisible.
 *
 * The pickers themselves are passed in already rendered: they are upstream
 * components with per-provider option lists, and re-deriving that here would
 * be a second source of truth.
 *
 * @module ComposerOptionsPopover
 */
import { type RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { ChevronUpIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { runtimeModeConfig, runtimeModeOptions } from "./composerRuntimeModes";
import { type ComposerOptionsSummary } from "./composerOptionsSummary";

export interface ComposerOptionsPopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Compact + full labels for the current model/effort/access selection. */
  readonly summary: ComposerOptionsSummary;
  /** Hide the summary text and show the chevron alone on narrow composers. */
  readonly compact: boolean;
  readonly disabled: boolean;
  /** Rendered `ProviderModelPicker`, or a stand-in when no provider is usable. */
  readonly modelPicker: ReactNode;
  /** Rendered provider traits picker (reasoning effort etc.), when supported. */
  readonly traitsPicker: ReactNode;
  readonly runtimeMode: RuntimeMode;
  readonly onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Effective context cap for the selected instance, e.g. "600k". Omitted for non-Claude providers. */
  readonly contextLimitLabel: string | null;
}

function OptionRow(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium text-foreground text-xs">{props.label}</div>
        {props.hint ? (
          <div className="truncate text-[11px] text-muted-foreground leading-4">{props.hint}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center justify-end">{props.children}</div>
    </div>
  );
}

export const ComposerOptionsPopover = memo(function ComposerOptionsPopover({
  open,
  onOpenChange,
  summary,
  compact,
  disabled,
  modelPicker,
  traitsPicker,
  runtimeMode,
  onRuntimeModeChange,
  contextLimitLabel,
}: ComposerOptionsPopoverProps) {
  const runtimeModeOption = runtimeModeConfig[runtimeMode];

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  data-chat-composer-options-trigger="true"
                  aria-label={`Session options — ${summary.detail}`}
                  className={cn(
                    "max-w-52 shrink-0 gap-1 px-2 text-muted-foreground/70 hover:text-foreground/80",
                    "data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
                  )}
                />
              }
            >
              {compact || summary.short.length === 0 ? null : (
                <span className="truncate text-xs">{summary.short}</span>
              )}
              <ChevronUpIcon
                aria-hidden="true"
                className="size-3.5 transition-transform in-data-[popup-open]:rotate-180"
              />
            </PopoverTrigger>
          }
        />
        <TooltipPopup side="top">{summary.detail}</TooltipPopup>
      </Tooltip>
      <PopoverPopup
        align="end"
        side="bottom"
        sideOffset={8}
        data-chat-composer-options-popup="true"
        // Width follows the widest control (model names vary a lot per
        // provider); a fixed width clips them against the viewport's
        // overflow-clip.
        className="!w-auto min-w-72 max-w-[min(26rem,calc(100vw-2rem))]"
        viewportClassName="py-3"
      >
        <div className="grid gap-2.5">
          <OptionRow label="Model">{modelPicker}</OptionRow>

          {traitsPicker ? <OptionRow label="Reasoning">{traitsPicker}</OptionRow> : null}

          <OptionRow label="Access" hint={runtimeModeOption.description}>
            <Select
              value={runtimeMode}
              onValueChange={(value) => onRuntimeModeChange(value as RuntimeMode)}
            >
              <SelectTrigger
                variant="ghost"
                size="sm"
                className="font-medium"
                aria-label="Runtime mode"
                data-chat-composer-runtime-mode="true"
              >
                <runtimeModeOption.icon className="size-4" />
                <SelectValue>{runtimeModeOption.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {runtimeModeOptions.map((mode) => {
                  const option = runtimeModeConfig[mode];
                  const OptionIcon = option.icon;
                  return (
                    <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                          <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          {option.label}
                        </span>
                        <span className="text-muted-foreground text-xs leading-4">
                          {option.description}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectPopup>
            </Select>
          </OptionRow>

          {contextLimitLabel ? (
            <OptionRow label="Context limit" hint="Compacts on approach. Change in Settings.">
              <span
                data-chat-composer-context-limit="true"
                className="rounded-md bg-muted/60 px-1.5 py-0.5 font-medium text-muted-foreground text-xs tabular-nums"
              >
                {contextLimitLabel}
              </span>
            </OptionRow>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
