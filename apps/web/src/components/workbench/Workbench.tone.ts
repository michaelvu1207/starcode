/**
 * Fork-owned: status → colour for the Workbench, in semantic tokens only.
 *
 * The sidebar's own status colours are raw palette hues (sky, amber, indigo)
 * inlined in an upstream-hot component. Reusing those literals here would mean
 * two copies of a palette that a theme pass is about to move underneath us, so
 * the Workbench maps the same five states onto the token layer instead:
 * anything a restyle recolours, it recolours here too.
 *
 * The mapping is deliberately the same shape for both status vocabularies — the
 * client's own thread status and the peer status the feature-flow endpoint
 * reports — so a thread does not change colour when it moves from the board to
 * the flow panel.
 */
import type { FeatureFlowMergeabilityState, PeerThreadStatus } from "@t3tools/contracts";

import type { SidebarV2Status } from "../Sidebar.logic";

export type WorkbenchTone = "working" | "attention" | "input" | "failed" | "done" | "quiet";

export function toneForThreadStatus(status: SidebarV2Status): WorkbenchTone {
  switch (status) {
    case "working":
      return "working";
    case "approval":
      return "attention";
    case "input":
      return "input";
    case "failed":
      return "failed";
    default:
      return "quiet";
  }
}

export function toneForPeerThreadStatus(status: PeerThreadStatus): WorkbenchTone {
  switch (status) {
    case "working":
      return "working";
    case "approval":
      return "attention";
    case "input":
      return "input";
    case "failed":
      return "failed";
    case "settled":
      return "done";
    default:
      return "quiet";
  }
}

export const WORKBENCH_TONE_DOT_CLASS: Readonly<Record<WorkbenchTone, string>> = {
  working: "bg-info",
  attention: "bg-warning",
  input: "bg-primary",
  failed: "bg-destructive",
  done: "bg-success",
  quiet: "bg-muted-foreground/40",
};

export const WORKBENCH_TONE_TEXT_CLASS: Readonly<Record<WorkbenchTone, string>> = {
  working: "text-info-foreground",
  attention: "text-warning-foreground",
  input: "text-primary",
  failed: "text-destructive-foreground",
  done: "text-success-foreground",
  quiet: "text-muted-foreground/70",
};

export const WORKBENCH_TONE_LABEL: Readonly<Record<WorkbenchTone, string>> = {
  working: "Working",
  attention: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  done: "Done",
  quiet: "Idle",
};

/**
 * The one mergeability surface on a feature node.
 *
 * `unknown` renders as nothing at all, per the contract's own instruction: the
 * server could not tell, and a grey dot would read as a judgement it did not
 * make. `blocked` is a warning rather than a destructive tone — something is in
 * the way, which is a normal state of stacked work, not a failure.
 */
export function mergeabilityDotClass(state: FeatureFlowMergeabilityState): string | null {
  switch (state) {
    case "ready":
      return "bg-success";
    case "blocked":
      return "bg-warning";
    default:
      return null;
  }
}

export function mergeabilityLabel(state: FeatureFlowMergeabilityState): string | null {
  switch (state) {
    case "ready":
      return "Ready to move on";
    case "blocked":
      return "Something is in the way";
    default:
      return null;
  }
}
