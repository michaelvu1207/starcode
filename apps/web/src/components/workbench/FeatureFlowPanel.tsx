/**
 * Fork-owned: the feature-flow panel.
 *
 * Features flow toward and through the places work actually lands: in progress,
 * then dev, then staging, then production. Nothing in this file renders a
 * branch, a worktree, a commit or an ahead/behind count — those exist on the
 * wire only because the server needed them to decide which lane a feature sits
 * in. The single readiness dot is the whole of the merge surface.
 *
 * Nodes are absolutely positioned from the geometry in `FeatureFlow.layout`, so
 * the dependency connectors drawn underneath them cannot disagree with where
 * they render — and a feature that changes lane animates its `top` into place
 * instead of teleporting.
 */
import { EnvironmentId, ThreadId, type FeatureFlowStage } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { ServerIcon } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { buildThreadRouteParams } from "../../threadRoutes";
import { useFeatureFlowView } from "../../state/featureFlow";
import { ThreadTaskProgress } from "../sidebar/ThreadTaskProgress";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  diffFeatureStages,
  layoutFeatureFlowSection,
  type FeatureFlowNode,
  type FeatureFlowSection,
} from "./FeatureFlow.layout";
import {
  mergeabilityDotClass,
  mergeabilityLabel,
  toneForPeerThreadStatus,
  WORKBENCH_TONE_DOT_CLASS,
  WORKBENCH_TONE_LABEL,
} from "./Workbench.tone";

/** Long enough to notice across the panel, short enough not to linger. */
const STAGE_FLASH_MS = 2_400;

function useStageChangeFlash(sections: ReadonlyArray<FeatureFlowSection>): ReadonlySet<string> {
  const previousStages = useRef<ReadonlyMap<string, FeatureFlowStage>>(new Map());
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const { changed, stages } = diffFeatureStages(previousStages.current, sections);
    previousStages.current = stages;
    if (changed.size === 0) return;
    setFlashing((current) => new Set([...current, ...changed]));
    const timer = window.setTimeout(() => {
      setFlashing((current) => {
        const next = new Set(current);
        for (const key of changed) next.delete(key);
        return next;
      });
    }, STAGE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [sections]);

  return flashing;
}

const FeatureNode = memo(function FeatureNode({
  node,
  flashing,
  onOpen,
}: {
  node: FeatureFlowNode;
  flashing: boolean;
  onOpen: (node: FeatureFlowNode) => void;
}) {
  const tone = toneForPeerThreadStatus(node.status);
  const readinessClass = mergeabilityDotClass(node.mergeability.state);
  const readinessText = mergeabilityLabel(node.mergeability.state);

  return (
    <button
      type="button"
      onClick={() => onOpen(node)}
      data-testid="feature-flow-node"
      className={cn(
        "flex h-full w-full cursor-pointer flex-col justify-center gap-1.5 rounded-lg border border-border/60 bg-card px-2.5 text-left",
        "hover:border-border hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        "transition-colors",
        flashing && "border-success/60 bg-success/8 motion-reduce:transition-none",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={WORKBENCH_TONE_LABEL[tone]}
                className={cn("size-1.5 shrink-0 rounded-full", WORKBENCH_TONE_DOT_CLASS[tone])}
              />
            }
          />
          <TooltipPopup side="top">{WORKBENCH_TONE_LABEL[tone]}</TooltipPopup>
        </Tooltip>
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{node.title}</span>
        {readinessClass !== null && readinessText !== null ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={readinessText}
                  className={cn("size-1.5 shrink-0 rounded-full", readinessClass)}
                />
              }
            />
            <TooltipPopup side="top">{readinessText}</TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
      <span className="flex min-w-0 items-center gap-1.5">
        {node.planSummary ? (
          <ThreadTaskProgress summary={node.planSummary} />
        ) : (
          <span className="flex-1" />
        )}
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-muted-foreground/70">
          <ServerIcon aria-hidden className="size-3" />
          <span className="max-w-20 truncate">{node.environmentLabel}</span>
        </span>
      </span>
    </button>
  );
});

function FeatureFlowSectionView({
  section,
  flashing,
  onOpen,
}: {
  section: FeatureFlowSection;
  flashing: ReadonlySet<string>;
  onOpen: (node: FeatureFlowNode) => void;
}) {
  const layout = layoutFeatureFlowSection(section.lanes);
  const nodeById = new Map(layout.nodes.map((node) => [node.key, node]));
  const { gutterWidth, nodeHeight, laneHeaderHeight } = layout.options;

  return (
    <section className="px-3 pb-4">
      <header className="flex min-w-0 items-center gap-2 pb-2">
        <h3 className="min-w-0 truncate text-xs font-medium text-foreground">{section.title}</h3>
        <span className="h-px flex-1 bg-border/60" />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/60">
          {section.featureCount}
        </span>
      </header>

      <div className="relative" style={{ height: layout.height }}>
        {/* The rail the dependency lines live in. Purely decorative: every
            relationship it draws is also stated by the lane a node sits in. */}
        <svg
          aria-hidden
          className="absolute left-0 top-0 overflow-visible text-muted-foreground/35"
          width={gutterWidth}
          height={layout.height}
        >
          {layout.edges.map((edge) => (
            <path
              key={edge.key}
              d={edge.path}
              fill="none"
              stroke="currentColor"
              strokeWidth={1}
              strokeLinecap="round"
            />
          ))}
        </svg>

        {layout.lanes.map((lane) => (
          <div
            key={lane.stage}
            className="absolute left-0 right-0 flex items-center gap-2"
            style={{ top: lane.y, height: laneHeaderHeight }}
          >
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
              {section.lanes.find((entry) => entry.stage === lane.stage)?.label}
            </span>
            <span className="h-px flex-1 bg-border/40" />
          </div>
        ))}

        {section.lanes.flatMap((lane) =>
          lane.nodes.map((node) => {
            const placement = nodeById.get(node.key);
            if (placement === undefined) return null;
            return (
              <div
                key={node.key}
                className="absolute right-0 transition-[top] duration-500 ease-out motion-reduce:transition-none"
                style={{ top: placement.y, height: nodeHeight, left: gutterWidth + 8 }}
              >
                <FeatureNode node={node} flashing={flashing.has(node.key)} onOpen={onOpen} />
              </div>
            );
          }),
        )}

        {layout.lanes.map((lane) =>
          lane.nodeCount === 0 ? (
            <div
              key={`${lane.stage}-empty`}
              className="absolute right-0 text-[10px] text-muted-foreground/40"
              style={{ top: lane.y + laneHeaderHeight, left: gutterWidth + 8 }}
            >
              nothing here yet
            </div>
          ) : null,
        )}
      </div>

      {section.diagnostics.length > 0 ? (
        <ul className="pt-2 text-[10px] text-muted-foreground/50">
          {section.diagnostics.map((diagnostic) => (
            <li key={diagnostic} className="truncate">
              {diagnostic}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function FeatureFlowPanel({ masterThreadKey }: { masterThreadKey: string | null }) {
  const view = useFeatureFlowView(masterThreadKey);
  const flashing = useStageChangeFlash(view.sections);
  const navigate = useNavigate();

  const openFeature = (node: FeatureFlowNode) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(
        scopeThreadRef(EnvironmentId.make(node.environmentId), ThreadId.make(node.threadId)),
      ),
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-xs font-medium text-foreground">Feature flow</h2>
        <span className="text-[11px] text-muted-foreground/60">to dev, staging, production</span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pt-3">
        {view.sections.length === 0 ? (
          <p className="px-3 text-xs text-muted-foreground/60">
            {view.pendingLabels.length > 0
              ? "Reading what each machine is working on…"
              : "Nothing in flight. Features appear here as threads start work on them."}
          </p>
        ) : (
          view.sections.map((section) => (
            <FeatureFlowSectionView
              key={section.key}
              section={section}
              flashing={flashing}
              onOpen={openFeature}
            />
          ))
        )}

        {view.unsupportedLabels.length > 0 ? (
          // Stated once, plainly. A machine mid-rollout is a normal state of a
          // fleet, not an error, and it must never read as one.
          <p className="px-3 pb-3 text-[11px] text-muted-foreground/40">
            Feature flow needs a server update on {view.unsupportedLabels.join(", ")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
