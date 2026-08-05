import { memo } from "react";
import { SparklesIcon, StarIcon } from "lucide-react";

import { ClaudeAI, OpenAI } from "../Icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export type ModelFamilyKey = "claude" | "gpt" | "other";
export type ModelFamilySelection = ModelFamilyKey | "favorites";

const FAMILY_ITEMS = [
  { key: "claude", label: "Claude", Icon: ClaudeAI },
  { key: "gpt", label: "Codex and GPT", Icon: OpenAI },
  { key: "other", label: "Other models", Icon: SparklesIcon },
] as const;

export const ModelFamilySidebar = memo(function ModelFamilySidebar(props: {
  selected: ModelFamilySelection;
  availableFamilies: ReadonlySet<ModelFamilyKey>;
  showFavorites: boolean;
  onSelect: (selection: ModelFamilySelection) => void;
}) {
  const itemClass =
    "relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:bg-[color-mix(in_srgb,var(--popover)_90%,var(--foreground))] focus-visible:outline-none";

  return (
    <div
      className="w-12 shrink-0 overflow-hidden border-r bg-muted/30"
      data-model-picker-sidebar="families"
    >
      <div className="flex h-full flex-col gap-1 overflow-y-auto px-1 pb-1 pt-0.5">
        {props.showFavorites ? (
          <div className="mb-1 border-b pb-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={cn(itemClass, props.selected === "favorites" && "bg-muted")}
                    onClick={() => props.onSelect("favorites")}
                    aria-label="Favorites"
                    data-model-picker-family="favorites"
                  >
                    <StarIcon className="size-5 fill-current" aria-hidden />
                    {props.selected === "favorites" ? (
                      <span className="absolute -right-1 top-1/2 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary" />
                    ) : null}
                  </button>
                }
              />
              <TooltipPopup side="left" sideOffset={8}>
                Favorites
              </TooltipPopup>
            </Tooltip>
          </div>
        ) : null}

        {FAMILY_ITEMS.filter((item) => props.availableFamilies.has(item.key)).map((item) => (
          <Tooltip key={item.key}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={cn(itemClass, props.selected === item.key && "bg-muted")}
                  onClick={() => props.onSelect(item.key)}
                  aria-label={item.label}
                  data-model-picker-family={item.key}
                >
                  <item.Icon className="size-5" aria-hidden />
                  {props.selected === item.key ? (
                    <span className="absolute -right-1 top-1/2 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-primary" />
                  ) : null}
                </button>
              }
            />
            <TooltipPopup side="left" sideOffset={8}>
              {item.label}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </div>
  );
});
