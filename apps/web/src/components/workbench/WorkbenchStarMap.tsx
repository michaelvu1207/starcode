/**
 * Fork-owned: the Workbench sky.
 *
 * Every piece of work is a star. How high it sits is how far it has flowed —
 * horizon for in progress, then dev, staging, production toward the zenith.
 * Which part of the sky it sits in is the machine running it, named on the
 * horizon beneath its constellation. Faint lines join a machine's own stars
 * into a figure; brighter ones cross between the pieces of work that wait on
 * one another.
 *
 * No git vocabulary reaches this file. A star has a name, a stage, a machine, a
 * status and a task list. Branches, worktrees and pull requests exist upstream
 * of the stage calculation and stop there.
 *
 * The sky is composed to fit the pane it is given, and there is deliberately no
 * pan and no zoom: at four machines and a few dozen pieces of work everything
 * is on screen at once, which is the whole point of a map. Panning would buy
 * room nobody needs at the price of hiding work off the edge of a void, and a
 * position you have to scroll to find is a position that encodes nothing.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useFeatureFlowView } from "../../state/featureFlow";
import { environmentServerConfigsAtom } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { SkySpecks } from "../brand/CelestialArt";
import { StarcodeMark } from "../brand/StarcodeWordmark";
import { partitionSidebarV2Threads } from "../Sidebar.partition";
import { buildThreadTaskProgress } from "../sidebar/ThreadTaskProgress.logic";
import { FEATURE_FLOW_STAGE_LABELS } from "./FeatureFlow.model";
import "./StarMap.css";
import {
  layoutStarMap,
  STAR_MAP_MIN_HEIGHT,
  type StarMapEdgeLayout,
  type StarMapLayout,
  type StarMapPlacedStar,
} from "./StarMap.layout";
import {
  buildStarMapModel,
  type StarMapMaster,
  type StarMapModel,
  type StarMapStar,
} from "./StarMap.model";
import { buildWorkbenchBoard } from "./Workbench.board";
import {
  WORKBENCH_TONE_DOT_CLASS,
  WORKBENCH_TONE_LABEL,
  WORKBENCH_TONE_SVG_CLASS,
  type WorkbenchTone,
} from "./Workbench.tone";

/** No change-request state here: it only feeds auto-settle ranking. */
const NO_CHANGE_REQUESTS: ReadonlyMap<string, "open" | "closed" | "merged"> = new Map();

/** How long the constellations take to finish tracing themselves in. */
const DRAW_IN_WINDOW_MS = 1_900;
const IGNITE_MS = 1_000;
/** Stagger between one line starting to draw and the next. */
const DRAW_IN_STAGGER_MS = 34;

/**
 * The wordmark's crescent as a bare path, for drawing inside an existing
 * `<svg>`. `StarcodeMark` renders its own root element and takes no geometry,
 * so nesting it would need a `<foreignObject>` to place — the path is the same
 * shape either way, and this keeps one copy of the crescent's coordinates.
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
        // Sub-pixel churn would relayout the whole sky every time a scrollbar
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

/** Stars that were not in the sky last time, so new work can ignite. */
function useIgnitingStars(keys: ReadonlyArray<string>): ReadonlySet<string> {
  const seen = useRef<ReadonlySet<string> | null>(null);
  const [igniting, setIgniting] = useState<ReadonlySet<string>>(() => new Set());
  const signature = keys.join(" ");

  useEffect(() => {
    const current = new Set(signature.length === 0 ? [] : signature.split(" "));
    const previous = seen.current;
    seen.current = current;
    // The first sky is not an arrival. Igniting everything on load would make
    // every visit look like four machines just started work at once.
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
 * A populated sky for development, behind `?starcode-demo`.
 *
 * `import.meta.env.DEV` is replaced at build time, so in a production bundle
 * this reads `if (false) return` and the dynamic import below is never emitted:
 * the fixture is absent from the shipped app rather than merely unreachable in
 * it. See `StarMap.demo` for why it exists.
 */
function useDemoModel(): StarMapModel | null {
  const [demo, setDemo] = useState<StarMapModel | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    if (!new URLSearchParams(window.location.search).has("starmap-demo")) return;
    void import("./StarMap.demo").then((module) => setDemo(module.buildStarMapDemoModel()));
  }, []);
  return demo;
}

function progressFraction(star: StarMapStar): number | null {
  const model = buildThreadTaskProgress({ summary: star.planSummary, reducedMotion: true });
  return model === null ? null : model.fraction;
}

function stageText(star: StarMapStar): string {
  return star.stageReported ? FEATURE_FLOW_STAGE_LABELS[star.stage] : "stage unreported";
}

function Star({
  placed,
  igniting,
  drawing,
  hovered,
  onOpen,
  onHover,
}: {
  readonly placed: StarMapPlacedStar;
  readonly igniting: boolean;
  readonly drawing: boolean;
  readonly hovered: boolean;
  readonly onOpen: (star: StarMapStar) => void;
  readonly onHover: (placed: StarMapPlacedStar | null) => void;
}) {
  const star = placed.star;
  const fraction = progressFraction(star);
  const radius = placed.radius;
  const starStyle = {
    // Consumed by the twinkle keyframes. Both come from the hash of the star's
    // own key, so a star breathes identically on every reload.
    "--sc-star-period": `${placed.twinklePeriodSeconds}s`,
    "--sc-star-delay": `${placed.twinkleDelaySeconds}s`,
  } as CSSProperties;

  return (
    <g
      className={cn(
        "sc-starmap-star cursor-pointer outline-none",
        WORKBENCH_TONE_SVG_CLASS[star.tone],
        star.settled && "sc-starmap-star--settled",
        star.alive && "sc-starmap-star--alive",
        igniting && "sc-starmap-star--igniting",
        // The glide a piece of work makes when it flows into the next stage.
        // Held back while the sky is still tracing itself in, or the first
        // paint would animate every star up from the origin.
        !drawing && "transition-transform duration-[900ms] ease-out motion-reduce:transition-none",
      )}
      data-testid="starmap-star"
      data-star-key={star.key}
      data-hovered={hovered ? "true" : undefined}
      transform={`translate(${placed.x} ${placed.y})`}
      style={starStyle}
      role="button"
      tabIndex={0}
      aria-label={`${star.title} — ${WORKBENCH_TONE_LABEL[star.tone]}, ${stageText(star)}, on ${star.machineLabel}`}
      onClick={() => onOpen(star)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(star);
      }}
      onMouseEnter={() => onHover(placed)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(placed)}
      onBlur={() => onHover(null)}
    >
      {/* The generous invisible target: a four-pixel dot is not something
          anyone should have to aim at. */}
      <circle r={radius + 11} fill="transparent" />
      <circle className="sc-starmap-halo" r={radius + 6} fill="currentColor" opacity={0.22} />
      <circle r={radius} fill="currentColor" />
      {star.masterCreated ? (
        // Started by the orchestrator. A ring rather than a badge: the sky has
        // no room for words it does not need.
        <circle
          data-testid="starmap-master-ring"
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
        // at twelve o'clock and running clockwise, the way anything read as a
        // dial is expected to.
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

function Edge({ edge, drawing }: { readonly edge: StarMapEdgeLayout; readonly drawing: boolean }) {
  const isDependency = edge.kind === "dependency";
  return (
    <path
      d={edge.d}
      data-testid={`starmap-edge-${edge.kind}`}
      pathLength={1}
      fill="none"
      stroke="currentColor"
      strokeWidth={isDependency ? 1 : 0.75}
      strokeLinecap="round"
      className={cn(
        "transition-[d] duration-[900ms] ease-out motion-reduce:transition-none",
        isDependency ? "text-primary/45" : "text-muted-foreground/25",
        drawing && "sc-starmap-edge--drawing",
      )}
      style={
        drawing
          ? ({ "--sc-edge-delay": `${edge.order * DRAW_IN_STAGGER_MS}ms` } as CSSProperties)
          : undefined
      }
    />
  );
}

function Moon({
  layout,
  master,
  onOpen,
}: {
  readonly layout: StarMapLayout;
  readonly master: StarMapMaster;
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
          more star: it is the body the rest of the sky is arranged under. */}
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
  readonly placed: StarMapPlacedStar;
  readonly layout: StarMapLayout;
}) {
  const star = placed.star;
  const fraction = progressFraction(star);
  // Above the star unless the star is near the top of the sky, where an
  // upward card would be clipped by the pane.
  const above = placed.y > 150;
  const left = Math.min(Math.max(placed.x, 118), Math.max(layout.width - 118, 118));
  return (
    <div
      data-testid="starmap-hover-card"
      className={cn(
        "pointer-events-none absolute z-10 w-56 -translate-x-1/2 rounded-xl border border-border/70 bg-popover/95 px-3 py-2 shadow-lg",
        above && "-translate-y-full",
      )}
      style={{ left, top: above ? placed.y - 18 : placed.y + 20 }}
    >
      <p className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn("size-1.5 shrink-0 rounded-full", WORKBENCH_TONE_DOT_CLASS[star.tone])}
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
          {star.title}
        </span>
      </p>
      <p className="pt-1 text-[11px] text-muted-foreground">
        {WORKBENCH_TONE_LABEL[star.tone]} · {stageText(star)}
      </p>
      <p className="truncate text-[11px] text-muted-foreground/70">
        {star.projectTitle === null
          ? star.machineLabel
          : `${star.projectTitle} · ${star.machineLabel}`}
      </p>
      {fraction === null || star.planSummary === null ? null : (
        <p className="pt-1 text-[11px] text-muted-foreground/70">
          {star.planSummary.completed} of {star.planSummary.total} tasks done
        </p>
      )}
      {star.mergeability === "unknown" ? null : (
        <p className="text-[11px] text-muted-foreground/70">
          {star.mergeability === "ready" ? "Ready to move on" : "Something is in the way"}
        </p>
      )}
      {star.masterCreated ? (
        <p className="text-[11px] text-primary/80">Started by the orchestrator</p>
      ) : null}
    </div>
  );
}

/** Bands, region dividers, the horizon, and the names on it. */
function SkyFrame({ layout }: { readonly layout: StarMapLayout }) {
  const railLeft = layout.options.gutterWidth - 10;
  const railRight = layout.width - layout.options.paddingRight;
  return (
    <g aria-hidden>
      {layout.bands.map((band, index) => (
        <g key={band.stage}>
          {/* Altitude reads as light: each stage sits a shade nearer the
              zenith's brightness than the one below it. Which direction that
              runs depends on the theme — see the rule in `StarMap.css`. */}
          <rect
            x={0}
            y={band.top}
            width={layout.width}
            height={band.height}
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
              y1={band.top}
              x2={railRight}
              y2={band.top}
              className="text-border"
              stroke="currentColor"
              strokeWidth={1}
              opacity={0.35}
            />
          ) : null}
          <text
            x={layout.options.gutterWidth - 16}
            y={band.centerY}
            textAnchor="end"
            dominantBaseline="middle"
            className="text-muted-foreground"
            fill="currentColor"
            fontSize={9}
            letterSpacing="0.06em"
            opacity={0.6}
          >
            {band.label.toUpperCase()}
          </text>
        </g>
      ))}

      {layout.regions.map((region) =>
        region.dividerX === null ? null : (
          <line
            key={`divider-${region.environmentId}`}
            x1={region.dividerX}
            y1={layout.skyTop}
            x2={region.dividerX}
            y2={layout.horizonY}
            className="text-border"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="1 7"
            opacity={0.75}
          />
        ),
      )}

      <line
        x1={railLeft}
        y1={layout.horizonY}
        x2={railRight}
        y2={layout.horizonY}
        className="text-border"
        stroke="currentColor"
        strokeWidth={1}
        opacity={0.7}
      />

      {layout.regions.map((region) => (
        <text
          key={`label-${region.environmentId}`}
          x={region.centerX}
          y={layout.horizonY + 18}
          textAnchor="middle"
          className="text-muted-foreground"
          fill="currentColor"
          fontSize={10}
          letterSpacing="0.04em"
          opacity={0.75}
        >
          {region.label}
        </text>
      ))}
    </g>
  );
}

function EmptySky({ pending }: { readonly pending: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center">
      <StarcodeMark className="size-7 text-muted-foreground/45" />
      <p className="text-sm text-muted-foreground/80">
        {pending ? "Looking up…" : "The sky is clear"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground/55">
        {pending
          ? "Waiting on your machines to say what they are carrying."
          : "Start a thread on any machine and it appears here as a star, rising as its work flows to dev, staging and production."}
      </p>
    </div>
  );
}

export function WorkbenchStarMap({
  masterThreadKey,
  master,
  masterCreatedThreadIds,
}: {
  readonly masterThreadKey: string | null;
  readonly master: StarMapMaster | null;
  readonly masterCreatedThreadIds: ReadonlySet<string>;
}) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const autoSettleAfterDays = useClientSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const threadLastVisitedAtById = useUiStateStore((store) => store.threadLastVisitedAtById);
  const nowMinute = useNowMinute();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const flow = useFeatureFlowView(masterThreadKey);

  const [containerRef, size] = useElementSize();
  const [hovered, setHovered] = useState<StarMapPlacedStar | null>(null);
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
    const partition = partitionSidebarV2Threads({
      threads,
      scopedProjectKeys: null,
      serverConfigs,
      changeRequestStateByKey: NO_CHANGE_REQUESTS,
      autoSettleAfterDays,
      threadLastVisitedAtById,
      threadSortOrder: "activity",
      nowMinute,
    });
    const board = buildWorkbenchBoard({
      activeThreads: partition.activeThreads,
      snoozedThreads: partition.snoozedThreads,
      settledThreads: partition.settledThreads,
      environments,
      primaryEnvironmentId,
      masterCreatedThreadIds,
      masterThreadKey,
      // The sky wants every piece of work it can place. Which settled work is
      // worth a star is decided by whether a machine can say where it landed,
      // not by a toggle.
      showSettled: true,
    });
    return buildStarMapModel({ board, flow, master, projectTitleByKey });
  }, [
    autoSettleAfterDays,
    environments,
    flow,
    master,
    masterCreatedThreadIds,
    masterThreadKey,
    nowMinute,
    primaryEnvironmentId,
    projectTitleByKey,
    serverConfigs,
    threadLastVisitedAtById,
    threads,
  ]);

  const model = demoModel ?? liveModel;
  const layout = useMemo(() => layoutStarMap(model, size), [model, size]);
  const starKeys = useMemo(() => layout.stars.map((placed) => placed.star.key), [layout]);
  const igniting = useIgnitingStars(starKeys);

  const openThread = useCallback(
    (environmentId: string, threadId: string) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
        ),
      });
    },
    [navigate],
  );

  const measured = size.width > 0 && size.height > 0;
  const empty = model.starCount === 0;
  const footnote =
    model.stageUnsupportedLabels.length > 0
      ? `Stages need a server update on ${model.stageUnsupportedLabels.join(", ")}`
      : (model.diagnostics[0] ?? "");

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-border/60 px-3 py-2">
        <h2 className="text-xs font-medium text-foreground">Sky</h2>
        <span className="truncate text-[11px] text-muted-foreground/60">
          {empty
            ? "nothing in flight"
            : `${model.starCount} in flight · ${model.regions.length} ${
                model.regions.length === 1 ? "machine" : "machines"
              } · rising toward production`}
        </span>
      </header>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        style={{ minHeight: STAR_MAP_MIN_HEIGHT }}
      >
        {/* The field the stars hang in. Full strength when the sky is empty,
            dimmed once there is work in it, so a real star is never in
            competition with the texture behind it. */}
        <div className={cn("absolute inset-0", !empty && "opacity-60")}>
          <SkySpecks />
        </div>

        {empty ? (
          <EmptySky pending={flow.pendingLabels.length > 0} />
        ) : measured ? (
          <>
            <svg
              width={layout.width}
              height={layout.height}
              viewBox={`0 0 ${layout.width} ${layout.height}`}
              className="absolute inset-0"
              data-testid="starmap-svg"
              role="group"
              aria-label="Work in flight, by stage and machine"
            >
              <SkyFrame layout={layout} />
              <g data-testid="starmap-edges">
                {layout.edges.map((edge) => (
                  <Edge key={edge.key} edge={edge} drawing={drawing} />
                ))}
              </g>
              <g>
                {layout.stars.map((placed) => (
                  <Star
                    key={placed.star.key}
                    placed={placed}
                    igniting={igniting.has(placed.star.key)}
                    drawing={drawing}
                    hovered={hovered?.star.key === placed.star.key}
                    onOpen={(star) => openThread(star.environmentId, star.threadId)}
                    onHover={setHovered}
                  />
                ))}
              </g>
              {model.master === null ? null : (
                <Moon
                  layout={layout}
                  master={model.master}
                  onOpen={() => openThread(model.master!.environmentId, model.master!.threadId)}
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
        </span>
      </footer>
    </div>
  );
}
