/**
 * "Price this model as that one" — the affordance on an unpriced model row.
 *
 * The rate table is vendored and it goes stale, so a machine that lives on
 * preview models reports half a million messages at $0.00. The panel's honest
 * answer to that has always been the unpriced note; this is the useful one.
 *
 * Two things it must be careful about.
 *
 * **It is a claim, not a measurement.** An assigned price is the operator's
 * guess at what an unknown model bills like, so every row that carries one
 * says whose price it borrowed — "gpt-5.6-sol · priced as gpt-5.5" — rather
 * than quietly folding into the real numbers beside it.
 *
 * **It is per machine.** The registry lives on the machine whose session files
 * produced the row, so the menu is disabled on a machine that cannot serve it
 * (an older server) rather than silently writing somewhere else.
 *
 * @module ModelPriceAssignment
 */
import { CheckIcon, TagIcon } from "lucide-react";

import type { CliUsageProvider } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";

export interface ModelPriceAssignmentProps {
  readonly provider: CliUsageProvider;
  readonly model: string;
  /** The model currently standing in, or null when the row is unpriced. */
  readonly pricedAs: string | null;
  /** Every id the machine's rate table can price. Empty disables the menu. */
  readonly priceable: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly onAssign: (input: {
    readonly provider: CliUsageProvider;
    readonly model: string;
    /** Null removes the assignment and restores the unpriced state. */
    readonly pricedAs: string | null;
  }) => void;
}

export function ModelPriceAssignment({
  provider,
  model,
  pricedAs,
  priceable,
  pending,
  onAssign,
}: ModelPriceAssignmentProps) {
  // Nothing to offer: an older server that cannot serve its rate table. The
  // affordance disappears rather than opening onto an empty menu.
  if (priceable.length === 0) return null;

  return (
    <Menu>
      <MenuTrigger
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] transition-colors",
          "text-muted-foreground/70 hover:bg-muted/50 hover:text-foreground",
          "data-popup-open:bg-muted/50 data-popup-open:text-foreground",
          pending ? "opacity-50" : "",
        )}
        disabled={pending}
      >
        <TagIcon className="size-3" />
        {pricedAs === null ? "assign price" : "change"}
      </MenuTrigger>
      <MenuPopup align="end" className="w-56">
        <p className="px-2 pb-1 pt-1 text-[11px] leading-[1.45] text-muted-foreground/70">
          Price <span className="font-mono text-foreground">{model}</span> as a model this build
          knows the rate for. Stored on this machine only.
        </p>
        <MenuSeparator />
        {pricedAs === null ? null : (
          <>
            <MenuItem
              onClick={() => {
                onAssign({ provider, model, pricedAs: null });
              }}
              variant="destructive"
            >
              Remove assignment
            </MenuItem>
            <MenuSeparator />
          </>
        )}
        {priceable.map((candidate) => (
          <MenuItem
            className="justify-between font-mono text-xs"
            key={candidate}
            onClick={() => {
              onAssign({ provider, model, pricedAs: candidate });
            }}
          >
            {candidate}
            {candidate === pricedAs ? <CheckIcon className="size-3.5" /> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
