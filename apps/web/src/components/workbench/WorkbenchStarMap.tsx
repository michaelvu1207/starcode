/**
 * Fork-owned: the Workbench sky.
 *
 * One constellation, growing from one point. The origin on the horizon is the
 * latest shared state everybody starts from; every feature branches off it, or
 * off another feature it is waiting on, and climbs as it matures — in flight,
 * landed, ready, shipped. Work under way is lit. Work the orchestrator has only
 * planned is a ghost on the same branches, so the intended shape and the actual
 * state are one picture.
 *
 * The sky is independent of connections by design. Which machine runs a piece
 * of work is a line on its card, never a place in the sky.
 *
 * No git vocabulary reaches this file. A feature has a name, a description, a
 * tier, a status and a task list. Branch containment exists upstream of the
 * stage computation and stops there.
 *
 * There is deliberately no pan and no zoom: the tree is laid out against the
 * measured pane, so the whole of it is on screen at once. Panning would buy
 * room nobody needs at the price of hiding work off the edge of a void.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useFeatureMapByEnvironment, useFeatureFlowView } from "../../state/featureFlow";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { SkySpecks } from "../brand/CelestialArt";
import { StarcodeMark } from "../brand/StarcodeWordmark";
import { partitionSidebarV2Threads } from "../Sidebar.partition";
import { buildThreadTaskProgress } from "../sidebar/ThreadTaskProgress.logic";
import "./StarMap.css";
import {
  layoutSky,
  SKY_MIN_HEIGHT,
  SKY_TIER_LABELS,
  type SkyBranchLayout,
  type SkyLayout,
  type SkyPlacedFeature,
} from "./StarMap.layout";
import {
  buildSkyModel,
  type SkyFeature,
  type SkyMaster,
  type SkyModel,
  type SkyProjectScope,
  type SkyThreadRef,
} from "./StarMap.model";
import { buildWorkbenchBoard } from "./Workbench.board";
import {
  WORKBENCH_TONE_DOT_CLASS,
  WORKBENCH_TONE_LABEL,
  WORKBENCH_TONE_SVG_CLASS,
  type WorkbenchTone,
} from "./Workbench.tone";

/** No change-request state here: it only feeds auto-settle ranking. */

/** How long the constellation takes to finish tracing itself out. */
const DRAW_IN_WINDOW_MS = 2_100;
const IGNITE_MS = 1_000;
/** Stagger between one branch starting to draw and the next. */
const DRAW_IN_STAGGER_MS = 38;

/**
 * The wordmark's crescent as a bare path, for drawing inside an existing
 * `<svg>`. `StarcodeMark` renders its own root element and takes no geometry,
 * so this keeps one copy of the crescent's coordinates rather than two.
 */
const CRESCENT_PATH = "M7.34 2.46 A8 8 0 1 0 17.54 12.66 A7.4 7.4 0 0 1 7.34 2.46 Z";
const CRESCENT_VIEWBOX = 20;

const LEGEND: ReadonlyArray<{ readonly tone: WorkbenchTone; readonly label: string }> = [
  { tone: "working", label: "working" },
  { tone: "attention", label: "needs you" },
  { tone: "failed", label: "failed" },
  { tone: "done", label: "done" },
];

function useElementSize(): [
  (element: HTMLElement | null) => void,
  { readonly width: number; readonly height: number },
] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect();
    if (element === null) return;
    const next = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box === undefined) return;
      setSize((current) =>
        // Sub-pixel churn would relayout the whole tree every time a scrollbar
        // appears somewhere else; whole pixels are all the geometry needs.
        Math.round(current.width) === Math.round(box.width) &&
        Math.round(current.height) === Math.round(box.height)
          ? current
          : { width: box.width, height: box.height },
      );
    });
    next.observe(element);
    observer.current = next;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);
  return [ref, size];
}

/** Features that were not in the sky last time, so new work can ignite. */
function useIgnitingFeatures(keys: ReadonlyArray<string>): ReadonlySet<string> {
  const seen = useRef<ReadonlySet<string> | null>(null);
  const [igniting, setIgniting] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys.join(" ");

  useEffect(() => {
    const current = new Set(signature.length === 0 ? [] : signature.split(" "));
    const previous = seen.current;
    seen.current = current;
    // The first sky is not an arrival. Igniting everything on load would make
    // every visit look like the whole plan just started at once.
    if (previous === null) return;
    const fresh = [...current].filter((key) => !previous.has(key));
    if (fresh.length === 0) return;
    setIgniting((now) => new Set([...now, ...fresh]));
    const timer = window.setTimeout(() => {
      setIgniting((now) => {
        const next = new Set(now);
        for (const key of fresh) next.delete(key);
        return next;
      });
    }, IGNITE_MS);
    return () => window.clearTimeout(timer);
  }, [signature]);

  return igniting;
}

/**
 * A populated sky for development, behind `?starmap-demo`.
 *
 * `import.meta.env.DEV` is replaced at build time, so in a production bundle
 * this reads `if (false) return` and the dynamic import below is never emitted:
 * the fixture is absent from the shipped app rather than merely unreachable in
 * it. See `StarMap.demo` for why it exists.
 */
function useDemoModel(): SkyModel | null {
  const [demo, setDemo] = useState<SkyModel | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!new URLSearchParams(window.location.search).has("starmap-demo")) return;
    void import("./StarMap.demo").then((module) => setDemo(module.buildSkyDemoModel()));
  }, []);
  return demo;
}

function progressFraction(feature: SkyFeature): number | null {
  const model = buildThreadTaskProgress({ summary: feature.planSummary, reducedMotion: true });
  return model === null ? null : model.fraction;
}

function tierText(feature: SkyFeature): string {
  return feature.stageReported ? SKY_TIER_LABELS[feature.stage] : "not placed yet";
}

function Star({
  placed,
  igniting,
  drawing,
  hovered,
  onOpen,
  onHover,
}: {
  readonly placed: SkyPlacedFeature;
  readonly igniting: boolean;
  readonly drawing: boolean;
  readonly hovered: boolean;
  readonly onOpen: (feature: SkyFeature) => void;
  readonly onHover: (placed: SkyPlacedFeature | null) => void;
}) {
  const feature = placed.feature;
  const fraction = progressFraction(feature);
  const radius = placed.radius;
  const openable = feature.threadRef !== null;
  const style = {
    // Consumed by the twinkle keyframes. Both come from the hash of the
    // feature's own key, so a star breathes identically on every reload.
    "--sc-star-period": `${placed.twinklePeriodSeconds}s`,
    "--sc-star-delay": `${placed.twinkleDelaySeconds}s`,
  } as CSSProperties;

  return (
    <g
      className={cn(
        "sc-starmap-star outline-none",
        openable ? "cursor-pointer" : "cursor-default",
        WORKBENCH_TONE_SVG_CLASS[feature.tone],
        feature.planned && "sc-starmap-star--planned",
        feature.landed && !feature.planned && "sc-starmap-star--landed",
        feature.alive && "sc-starmap-star--alive",
        igniting && "sc-starmap-star--igniting",
        // The glide a feature makes when it climbs a tier. Held back while the
        // sky is still tracing itself, or the first paint animates from origin.
        !drawing && "transition-transform duration-[900ms] ease-out motion-reduce:transition-none",
      )}
      data-testid="starmap-star"
      data-star-key={feature.key}
      data-planned={feature.planned ? "true" : undefined}
      data-hovered={hovered ? "true" : undefined}
      transform={`translate(${placed.x} ${placed.y})`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`${feature.name} — ${
        feature.planned ? "planned" : WORKBENCH_TONE_LABEL[feature.tone]
      }, ${tierText(feature)}`}
      onClick={() => onOpen(feature)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(feature);
      }}
      onMouseEnter={() => onHover(placed)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(placed)}
      onBlur={() => onHover(null)}
    >
      {/* The generous invisible target: a seven-pixel dot is not something
          anyone should have to aim at. */}
      <circle r={radius + 11} fill="transparent" />
      {feature.planned ? (
        // A ghost: outline only, so intent never reads as work. The whole
        // difference between the plan and the sky is this one shape.
        <circle
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.25}
          strokeDasharray="2.5 2.5"
        />
      ) : (
        <>
          <circle className="sc-starmap-halo" r={radius + 6} fill="currentColor" opacity={0.22} />
          <circle r={radius} fill="currentColor" />
        </>
      )}
      {feature.masterAuthored && !feature.planned ? (
        // Written down by the orchestrator rather than merely observed. A ring,
        // not a badge: the sky has no room for words it does not need.
        <circle
          data-testid="starmap-authored-ring"
          r={radius + 8}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.75}
          strokeDasharray="2 3"
          opacity={0.45}
        />
      ) : null}
      {fraction === null ? null : (
        // The task list, as an arc that closes as the work completes. Started
        // at twelve o'clock and running clockwise, the way a dial is expected to.
        <circle
          data-testid="starmap-progress"
          r={radius + 4}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - fraction}
          opacity={0.85}
          transform="rotate(-90)"
        />
      )}
      <circle
        className="sc-starmap-focus"
        r={radius + 9}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
      />
    </g>
  );
}

/**
 * A lineage edge, and the one line on the sky that had to get brighter.
 *
 * These carry information — which feature grows out of which — so they answer
 * to the 3:1 component floor rather than to taste. Two things forced the
 * treatment they have:
 *
 *   - The base is `foreground`, not `muted-foreground`. Muted cannot reach 3:1
 *     over linen at *any* alpha (it tops out near 4.4:1 on paper and lands
 *     under the floor once the sky wash is over it), so no opacity bump to the
 *     old token could have worked in both themes.
 *   - The alphas are high for a hairline because a 1px stroke only ever covers
 *     part of the pixels it crosses. Nominal contrast overstates what the eye
 *     gets from a thin line, so the number has to run ahead of the floor.
 *
 * Ghost edges stay subordinate through weight and dash, and keep a visible
 * step of contrast, but they are *not* exempt from the floor: a plan whose
 * branching cannot be traced is not conveying the plan.
 *
 * `check-starcode-contrast.mjs` re-derives both numbers against every sky
 * phase, the tier bands and a chrome star. Change either alpha and run it.
 */
const BRANCH_STROKE = {
  real: "text-foreground/70",
  planned: "text-foreground/60",
} as const;

function Branch({
  branch,
  drawing,
}: {
  readonly branch: SkyBranchLayout;
  readonly drawing: boolean;
}) {
  return (
    <path
      d={branch.d}
      data-testid={branch.planned ? "starmap-branch-planned" : "starmap-branch"}
      pathLength={1}
      fill="none"
      stroke="currentColor"
      strokeWidth={branch.planned ? 0.75 : 1}
      strokeLinecap="round"
      className={cn(
        "transition-[d] duration-[900ms] ease-out motion-reduce:transition-none",
        branch.planned ? BRANCH_STROKE.planned : BRANCH_STROKE.real,
        drawing && "sc-starmap-edge--drawing",
      )}
      strokeDasharray={branch.planned && !drawing ? "3 4" : undefined}
      style={
        drawing
          ? ({ "--sc-edge-delay": `${branch.order * DRAW_IN_STAGGER_MS}ms` } as CSSProperties)
          : undefined
      }
    />
  );
}

/** The shared start. Everything in the sky grows out of this one point. */
function Origin({ layout }: { readonly layout: SkyLayout }) {
  const { origin } = layout;
  return (
    <g aria-hidden data-testid="starmap-origin" transform={`translate(${origin.x} ${origin.y})`}>
      <circle className="text-primary" r={origin.radius + 13} fill="currentColor" opacity={0.09} />
      <circle className="text-primary" r={origin.radius + 5} fill="currentColor" opacity={0.16} />
      <circle className="text-primary" r={origin.radius} fill="currentColor" />
      <text
        y={origin.radius + 20}
        textAnchor="middle"
        className="text-foreground"
        fill="currentColor"
        fontSize={11}
        letterSpacing="0.05em"
        opacity={0.85}
      >
        {origin.label}
      </text>
    </g>
  );
}

function Moon({
  layout,
  master,
  onOpen,
}: {
  readonly layout: SkyLayout;
  readonly master: SkyMaster;
  readonly onOpen: () => void;
}) {
  const moon = layout.moon;
  if (moon === null) return null;
  const scale = (moon.radius * 2) / CRESCENT_VIEWBOX;
  return (
    <g
      className="sc-starmap-moon cursor-pointer text-primary outline-none"
      data-testid="starmap-moon"
      transform={`translate(${moon.x} ${moon.y})`}
      role="button"
      tabIndex={0}
      aria-label={`${master.title} — the orchestrator, on ${master.machineLabel}`}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
    >
      <title>{`${master.title} — the orchestrator, on ${master.machineLabel}`}</title>
      <circle r={moon.radius + 15} fill="transparent" />
      <circle r={moon.radius + 8} fill="currentColor" opacity={0.1} />
      {/* The wordmark's own crescent, at sky scale. The orchestrator is not one
          more feature: it is the body the rest of the sky is arranged under. */}
      <g transform={`scale(${scale}) translate(${-CRESCENT_VIEWBOX / 2} ${-CRESCENT_VIEWBOX / 2})`}>
        <path d={CRESCENT_PATH} fill="currentColor" />
      </g>
    </g>
  );
}

function HoverCard({
  placed,
  layout,
}: {
  readonly placed: SkyPlacedFeature;
  readonly layout: SkyLayout;
}) {
  const feature = placed.feature;
  const fraction = progressFraction(feature);
  // Above the star unless it is near the top of the sky, where an upward card
  // would be clipped by the pane.
  const above = placed.y > 170;
  const left = Math.min(Math.max(placed.x, 122), Math.max(layout.width - 122, 122));
  return (
    <div
      data-testid="starmap-hover-card"
      className={cn(
        "pointer-events-none absolute z-10 w-60 -translate-x-1/2 rounded-xl border border-border/70 bg-popover/95 px-3 py-2 shadow-lg",
        above && "-translate-y-full",
      )}
      style={{ left, top: above ? placed.y - 20 : placed.y + 22 }}
    >
      <p className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            feature.planned
              ? "border border-muted-foreground/60 bg-transparent"
              : WORKBENCH_TONE_DOT_CLASS[feature.tone],
          )}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {feature.name}
        </span>
      </p>
      {feature.description === null ? null : (
        <p className="line-clamp-2 pt-1 text-[11px] text-muted-foreground/80">
          {feature.description}
        </p>
      )}
      <p className="pt-1 text-[11px] text-muted-foreground">
        {feature.planned ? "Planned" : WORKBENCH_TONE_LABEL[feature.tone]} · {tierText(feature)}
      </p>
      {feature.projectTitle === null && feature.machineLabel === null ? null : (
        <p className="truncate text-[11px] text-muted-foreground/70">
          {[feature.projectTitle, feature.machineLabel].filter(Boolean).join(" · ")}
        </p>
      )}
      {fraction === null || feature.planSummary === null ? null : (
        <p className="pt-1 text-[11px] text-muted-foreground/70">
          {feature.planSummary.completed} of {feature.planSummary.total} tasks done
        </p>
      )}
      {feature.mergeability === "unknown" ? null : (
        <p className="text-[11px] text-muted-foreground/70">
          {feature.mergeability === "ready" ? "Ready to move on" : "Something is in the way"}
        </p>
      )}
      {feature.planned ? (
        <p className="pt-1 text-[11px] text-muted-foreground/60">
          Not started. It becomes real when a thread takes it on.
        </p>
      ) : null}
    </div>
  );
}

/** Tier bands, their names, the horizon, and nothing about machines. */
function SkyFrame({ layout }: { readonly layout: SkyLayout }) {
  const railLeft = layout.options.gutterWidth - 10;
  const railRight = layout.width - layout.options.paddingRight;
  return (
    <g aria-hidden>
      {layout.tiers.map((tier, index) => (
        <g key={tier.stage}>
          {/* Altitude reads as light: each tier sits a shade nearer the
              zenith's brightness than the one below it. Which direction that
              runs depends on the theme — see the rule in `StarMap.css`. */}
          <rect
            x={0}
            y={tier.top}
            width={layout.width}
            height={tier.height}
            className="sc-starmap-band text-foreground"
            style={
              {
                "--sc-band-dark": 0.008 + index * 0.008,
                "--sc-band-light": 0.03 - index * 0.008,
              } as CSSProperties
            }
          />
          {index > 0 ? (
            <line
              x1={railLeft}
              y1={tier.top}
              x2={railRight}
              y2={tier.top}
              className="text-border"
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.3}
            />
          ) : null}
          <text
            x={layout.options.gutterWidth - 16}
            y={tier.centerY}
            textAnchor="end"
            dominantBaseline="middle"
            className="text-muted-foreground"
            fill="currentColor"
            fontSize={9}
            letterSpacing="0.06em"
            opacity={0.6}
          >
            {tier.label.toUpperCase()}
          </text>
        </g>
      ))}

      <line
        x1={railLeft}
        y1={layout.horizonY}
        x2={railRight}
        y2={layout.horizonY}
        className="text-border"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.5}
      />
    </g>
  );
}

function EmptySky({
  pending,
  emptyLabel,
}: {
  readonly pending: boolean;
  readonly emptyLabel?: string;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <StarcodeMark className="size-7 text-muted-foreground/45" />
      <p className="text-sm text-muted-foreground/80">
        {pending ? "Looking up…" : "The sky is clear"}
      </p>
      <p className="max-w-sm text-xs text-muted-foreground/55">
        {pending
          ? "Waiting on your machines to say what they are carrying."
          : // A project's sky is empty for a different reason than the fleet's
            // — usually "nothing is filed here yet" rather than "nothing is
            // running anywhere" — so the caller supplies its own sentence.
            (emptyLabel ??
            "Every feature branches off the latest. Start a thread, or have the orchestrator lay out a plan, and the first branch appears here.")}
      </p>
    </div>
  );
}

export function WorkbenchStarMap({
  masterThreadKey,
  master,
  masterCreatedThreadIds,
  scope = null,
  emptyLabel,
}: {
  readonly masterThreadKey: string | null;
  readonly master: SkyMaster | null;
  readonly masterCreatedThreadIds: ReadonlySet<string>;
  /**
   * Scopes the sky to one project. Null — the default — is the fleet, which is
   * what `/workbench` passes and what this component did before projects
   * existed.
   *
   * One object rather than a bare thread predicate: the board, the flow and the
   * feature map all have to be narrowed by the same project, and passing them
   * separately is how the map came to be narrowed by nothing at all.
   */
  readonly scope?: SkyProjectScope | null;
  /** What an empty sky says. A project's sky is empty for different reasons. */
  readonly emptyLabel?: string;
}) {
  const includeThreadKey = scope?.includeThreadKey ?? null;
  const navigate = useNavigate();
  const threads = useThreadShells();
  const projects = useProjects();
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const flow = useFeatureFlowView(masterThreadKey, includeThreadKey);
  const mapEntriesByEnvironment = useFeatureMapByEnvironment();

  const [containerRef, size] = useElementSize();
  const [hovered, setHovered] = useState<SkyPlacedFeature | null>(null);
  const [drawing, setDrawing] = useState(true);

  useEffect(() => {
    const timer = window.setTimeout(() => setDrawing(false), DRAW_IN_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, []);

  const projectTitleByKey = useMemo(
    () =>
      new Map(
        projects.map(
          (project) => [`${project.environmentId}:${project.id}`, project.title] as const,
        ),
      ),
    [projects],
  );

  const demoModel = useDemoModel();
  const liveModel = useMemo(() => {
    const board = buildWorkbenchBoard({
      threads: partitionSidebarV2Threads({
        threads,
        scopedProjectKeys: null,
        threadLastVisitedAtById,
        threadSortOrder: "activity",
      }),
      environments,
      primaryEnvironmentId,
      masterCreatedThreadIds,
      masterThreadKey,
      includeThreadKey,
    });
    return buildSkyModel({
      board,
      flow,
      mapEntriesByEnvironment,
      master,
      projectTitleByKey,
      scope,
    });
  }, [
    environments,
    flow,
    includeThreadKey,
    mapEntriesByEnvironment,
    master,
    masterCreatedThreadIds,
    masterThreadKey,
    primaryEnvironmentId,
    projectTitleByKey,
    scope,
    threadLastVisitedAtById,
    threads,
  ]);

  const model = demoModel ?? liveModel;
  const layout = useMemo(() => layoutSky(model, size), [model, size]);
  const keys = useMemo(() => layout.features.map((placed) => placed.feature.key), [layout]);
  const igniting = useIgnitingFeatures(keys);

  const openThread = useCallback(
    (ref: SkyThreadRef) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(EnvironmentId.make(ref.environmentId), ThreadId.make(ref.threadId)),
        ),
      });
    },
    [navigate],
  );

  const openFeature = useCallback(
    (feature: SkyFeature) => {
      // A planned feature has nothing to open yet. Doing nothing is the honest
      // response; the card already says why.
      if (feature.threadRef === null) return;
      openThread(feature.threadRef);
    },
    [openThread],
  );

  const measured = size.width > 0 && size.height > 0;
  const empty = model.features.length === 0;
  // A machine that is connected and simply did not answer outranks the others:
  // the count above is wrong by however much that machine was carrying, and
  // saying nothing was how that went unnoticed.
  const footnote =
    model.stageUnreadableLabels.length > 0
      ? `Could not read work on ${model.stageUnreadableLabels.join(", ")} — the count above is short`
      : model.stageUnsupportedLabels.length > 0
        ? `Stages need a server update on ${model.stageUnsupportedLabels.join(", ")}`
        : (model.diagnostics[0] ?? "");

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-xs font-medium text-foreground">Sky</h2>
        <span className="truncate text-[11px] text-muted-foreground/60">
          {empty
            ? "nothing growing yet"
            : `${model.realCount} ${model.realCount === 1 ? "feature" : "features"} branching off latest${
                model.plannedCount > 0 ? ` · ${model.plannedCount} planned` : ""
              }`}
        </span>
      </header>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ minHeight: SKY_MIN_HEIGHT }}
      >
        {/* The field the constellation hangs in. Full strength when the sky is
            empty, dimmed once there is work in it, so a real star is never in
            competition with the texture behind it. */}
        <div className={cn("absolute inset-0", !empty && "opacity-60")}>
          <SkySpecks />
        </div>

        {empty ? (
          <EmptySky
            pending={flow.pendingLabels.length > 0}
            {...(emptyLabel === undefined ? {} : { emptyLabel })}
          />
        ) : measured ? (
          <>
            <svg
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="absolute inset-0"
              data-testid="starmap-svg"
              role="group"
              aria-label="Features branching off the latest shared state"
            >
              <SkyFrame layout={layout} />
              <g data-testid="starmap-branches">
                {layout.branches.map((branch) => (
                  <Branch key={branch.key} branch={branch} drawing={drawing} />
                ))}
              </g>
              <Origin layout={layout} />
              <g>
                {layout.features.map((placed) => (
                  <Star
                    key={placed.feature.key}
                    placed={placed}
                    igniting={igniting.has(placed.feature.key)}
                    drawing={drawing}
                    hovered={hovered?.feature.key === placed.feature.key}
                    onOpen={openFeature}
                    onHover={setHovered}
                  />
                ))}
              </g>
              {model.master === null ? null : (
                <Moon
                  layout={layout}
                  master={model.master}
                  onOpen={() =>
                    openThread({
                      environmentId: model.master!.environmentId,
                      threadId: model.master!.threadId,
                    })
                  }
                />
              )}
            </svg>
            {hovered === null ? null : <HoverCard placed={hovered} layout={layout} />}
          </>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/60 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground/45">
          {/* A machine mid-rollout is a normal state of a fleet, named once and
              plainly. Machines that are simply not connected are not named:
              they have not been asked. */}
          {footnote}
        </span>
        <span className={cn("flex shrink-0 items-center gap-2.5", empty && "hidden")}>
          {LEGEND.map((entry) => (
            <span key={entry.tone} className="flex items-center gap-1">
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", WORKBENCH_TONE_DOT_CLASS[entry.tone])}
              />
              <span className="text-[10px] text-muted-foreground/55">{entry.label}</span>
            </span>
          ))}
          {model.plannedCount > 0 ? (
            <span className="flex items-center gap-1">
              <span
                aria-hidden
                className="size-1.5 rounded-full border border-muted-foreground/60"
              />
              <span className="text-[10px] text-muted-foreground/55">planned</span>
            </span>
          ) : null}
        </span>
      </footer>
    </div>
  );
}
