/**
 * Fork-owned: the feature-flow panel's model and geometry.
 *
 * The panel answers three questions and no others: what is being worked on for
 * this project, how far along each piece is, and what has flowed into dev,
 * staging and production. Everything the server needed to answer them — branch
 * containment, ahead/behind counts, pull requests — is plumbing that stops
 * here. Nothing below this line renders a branch name or a count; the only
 * trace is a single readiness dot.
 *
 * Geometry lives here rather than in CSS because the dependency connectors are
 * drawn as SVG over the same coordinate space the nodes occupy. Letting flex
 * decide the y positions and then guessing them for the lines is how connectors
 * end up a few pixels off on one machine's font metrics. Nodes are absolutely
 * positioned from these numbers, so the lines cannot disagree with them — and
 * animating `top` gives the glide between lanes for free.
 */
import type {
  FeatureFlowFeature,
  FeatureFlowSnapshot,
  FeatureFlowStage,
  FeatureFlowMergeability,
  OrchestrationThreadPlanSummary,
  PeerThreadStatus,
} from "@t3tools/contracts";

/** Lane order is the order work flows, left to right in the mind, top to bottom on screen. */
export const FEATURE_FLOW_LANE_STAGES = [
  "in-progress",
  "in-dev",
  "in-staging",
  "in-production",
] as const satisfies ReadonlyArray<FeatureFlowStage>;

export const FEATURE_FLOW_LANE_LABELS: Readonly<Record<FeatureFlowStage, string>> = {
  "in-progress": "In progress",
  "in-dev": "dev",
  "in-staging": "staging",
  "in-production": "production",
};

export interface FeatureFlowNode {
  /** Unique across machines: two servers can hold threads with the same id. */
  readonly key: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly title: string;
  readonly status: PeerThreadStatus;
  readonly stage: FeatureFlowStage;
  readonly planSummary: OrchestrationThreadPlanSummary | null;
  readonly mergeability: FeatureFlowMergeability;
  /** Keys of features this one waits on, already narrowed to features on screen. */
  readonly dependsOnKeys: ReadonlyArray<string>;
  readonly lastActivityAt: string;
}

export interface FeatureFlowLane {
  readonly stage: FeatureFlowStage;
  readonly label: string;
  readonly nodes: ReadonlyArray<FeatureFlowNode>;
}

export interface FeatureFlowSection {
  /** Stable across machines: the same repository checked out on two machines is one project. */
  readonly key: string;
  readonly title: string;
  readonly lanes: ReadonlyArray<FeatureFlowLane>;
  readonly featureCount: number;
  readonly machineLabels: ReadonlyArray<string>;
  readonly diagnostics: ReadonlyArray<string>;
}

export interface FeatureFlowEnvironmentInput {
  readonly environmentId: string;
  readonly label: string;
  readonly snapshot: FeatureFlowSnapshot | null;
  /** False once the machine has answered and could not serve the route. */
  readonly supported: boolean;
  readonly pending: boolean;
}

export interface FeatureFlowView {
  readonly sections: ReadonlyArray<FeatureFlowSection>;
  /** Machines whose server cannot report feature flow, named so the gap is visible. */
  readonly unsupportedLabels: ReadonlyArray<string>;
  readonly pendingLabels: ReadonlyArray<string>;
}

const featureKey = (environmentId: string, threadId: string): string =>
  `${environmentId}:${threadId}`;

/**
 * Projects are keyed by the last segment of their workspace path, not by
 * project id or full path: the same repository on two machines has different
 * ids and different absolute paths, and showing it as two projects would split
 * a pipeline in half. Machine identity is not lost — every node carries it.
 */
export function featureFlowProjectKey(workspaceRoot: string, title: string): string {
  const trimmed = workspaceRoot.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  const basename = segments[segments.length - 1] ?? "";
  return (basename.length > 0 ? basename : title).toLowerCase();
}

const stageRank = (stage: FeatureFlowStage): number => {
  const index = FEATURE_FLOW_LANE_STAGES.indexOf(stage);
  return index === -1 ? FEATURE_FLOW_LANE_STAGES.length : index;
};

const activityMs = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

interface CollectedFeature {
  readonly node: FeatureFlowNode;
  readonly dependsOnThreadIds: ReadonlyArray<string>;
}

function collectFeature(
  environment: FeatureFlowEnvironmentInput,
  feature: FeatureFlowFeature,
): CollectedFeature {
  return {
    node: {
      key: featureKey(environment.environmentId, feature.threadId),
      threadId: feature.threadId,
      environmentId: environment.environmentId,
      environmentLabel: environment.label,
      title: feature.title,
      status: feature.status,
      stage: feature.stage,
      planSummary: feature.planSummary,
      mergeability: feature.mergeability,
      dependsOnKeys: [],
      lastActivityAt: feature.lastActivityAt,
    },
    dependsOnThreadIds: feature.dependsOn.map((dependency) => dependency.dependsOnThreadId),
  };
}

/**
 * Composes every machine's answer into per-project pipelines.
 *
 * Dependencies resolve within a machine only. The server infers them from one
 * repository's history, so a dependency id from machine A means nothing on
 * machine B — resolving across machines would invent edges out of colliding
 * ids.
 */
export interface FeatureFlowViewOptions {
  /**
   * The orchestrator's key. It is a thread with a branch like any other, so the
   * server reports it as a feature — but it is the thing directing the work,
   * not one of the pieces of work, and showing it in a lane makes the pipeline
   * claim something it does not mean.
   */
  readonly excludeThreadKey?: string | null;
}

export function buildFeatureFlowView(
  environments: ReadonlyArray<FeatureFlowEnvironmentInput>,
  options?: FeatureFlowViewOptions,
): FeatureFlowView {
  interface SectionAccumulator {
    key: string;
    titles: string[];
    features: CollectedFeature[];
    machineLabels: Set<string>;
    diagnostics: string[];
  }
  const sections = new Map<string, SectionAccumulator>();
  const unsupportedLabels: string[] = [];
  const pendingLabels: string[] = [];

  for (const environment of environments) {
    if (environment.snapshot === null) {
      if (environment.pending) pendingLabels.push(environment.label);
      else if (!environment.supported) unsupportedLabels.push(environment.label);
      continue;
    }
    for (const project of environment.snapshot.projects) {
      const key = featureFlowProjectKey(project.workspaceRoot, project.title);
      const existing = sections.get(key);
      const section: SectionAccumulator = existing ?? {
        key,
        titles: [],
        features: [],
        machineLabels: new Set<string>(),
        diagnostics: [],
      };
      if (existing === undefined) sections.set(key, section);
      section.titles.push(project.title);
      for (const feature of project.features) {
        if (featureKey(environment.environmentId, feature.threadId) === options?.excludeThreadKey) {
          continue;
        }
        section.features.push(collectFeature(environment, feature));
        section.machineLabels.add(environment.label);
      }
      for (const diagnostic of project.diagnostics) {
        // Attributed, because "not a git repository" is only actionable if you
        // know which machine is saying it.
        const attributed = `${environment.label}: ${diagnostic}`;
        if (!section.diagnostics.includes(attributed)) section.diagnostics.push(attributed);
      }
    }
  }

  const built = [...sections.values()]
    .map((section): FeatureFlowSection => {
      const keysInView = new Set(section.features.map((entry) => entry.node.key));
      const nodes = section.features.map((entry): FeatureFlowNode => {
        const dependsOnKeys = entry.dependsOnThreadIds
          .map((threadId) => featureKey(entry.node.environmentId, threadId))
          .filter((key) => keysInView.has(key) && key !== entry.node.key);
        return { ...entry.node, dependsOnKeys };
      });

      const lanes = FEATURE_FLOW_LANE_STAGES.map(
        (stage): FeatureFlowLane => ({
          stage,
          label: FEATURE_FLOW_LANE_LABELS[stage],
          nodes: nodes
            .filter((node) => node.stage === stage)
            .toSorted(
              (left, right) =>
                activityMs(right.lastActivityAt) - activityMs(left.lastActivityAt) ||
                left.title.localeCompare(right.title) ||
                left.key.localeCompare(right.key),
            ),
        }),
      );

      return {
        key: section.key,
        title: section.titles[0] ?? section.key,
        lanes,
        featureCount: nodes.length,
        machineLabels: [...section.machineLabels].toSorted((left, right) =>
          left.localeCompare(right),
        ),
        diagnostics: section.diagnostics,
      };
    })
    // A project with nothing in flight is not a pipeline, it is noise.
    .filter((section) => section.featureCount > 0)
    .toSorted(
      (left, right) =>
        right.featureCount - left.featureCount || left.title.localeCompare(right.title),
    );

  return { sections: built, unsupportedLabels, pendingLabels };
}

// ── Geometry ────────────────────────────────────────────────────────

export interface FeatureFlowLayoutOptions {
  readonly nodeHeight: number;
  readonly nodeGap: number;
  readonly laneHeaderHeight: number;
  readonly laneGap: number;
  /** Width of the left rail the connectors are drawn in. */
  readonly gutterWidth: number;
  /** Height an empty lane still occupies, so a lane never collapses to nothing. */
  readonly emptyLaneHeight: number;
}

export const FEATURE_FLOW_LAYOUT: FeatureFlowLayoutOptions = {
  nodeHeight: 62,
  nodeGap: 8,
  laneHeaderHeight: 24,
  laneGap: 12,
  gutterWidth: 18,
  emptyLaneHeight: 18,
};

export interface FeatureFlowLayoutLane {
  readonly stage: FeatureFlowStage;
  readonly y: number;
  readonly height: number;
  readonly nodeCount: number;
}

export interface FeatureFlowLayoutNode {
  readonly key: string;
  readonly y: number;
  readonly centerY: number;
}

export interface FeatureFlowLayoutEdge {
  readonly key: string;
  readonly fromKey: string;
  readonly toKey: string;
  /** SVG path in the gutter's coordinate space, y shared with the node stack. */
  readonly path: string;
}

export interface FeatureFlowLayout {
  readonly height: number;
  readonly lanes: ReadonlyArray<FeatureFlowLayoutLane>;
  readonly nodes: ReadonlyArray<FeatureFlowLayoutNode>;
  readonly edges: ReadonlyArray<FeatureFlowLayoutEdge>;
  readonly options: FeatureFlowLayoutOptions;
}

/**
 * Stacks lanes and their nodes into one coordinate space and routes a connector
 * for every dependency whose other end is also on screen.
 *
 * Connectors bow into the gutter rather than running straight down it so two
 * edges spanning the same rows stay distinguishable; the bow depth grows with
 * the vertical distance, which is what keeps a short hop from looking like a
 * long one.
 */
export function layoutFeatureFlowSection(
  lanes: ReadonlyArray<FeatureFlowLane>,
  options: FeatureFlowLayoutOptions = FEATURE_FLOW_LAYOUT,
): FeatureFlowLayout {
  const layoutLanes: FeatureFlowLayoutLane[] = [];
  const nodes: FeatureFlowLayoutNode[] = [];
  const centerByKey = new Map<string, number>();

  let cursor = 0;
  lanes.forEach((lane, laneIndex) => {
    const laneTop = cursor;
    cursor += options.laneHeaderHeight;
    if (lane.nodes.length === 0) {
      cursor += options.emptyLaneHeight;
    } else {
      lane.nodes.forEach((node, nodeIndex) => {
        const y = cursor;
        const centerY = y + options.nodeHeight / 2;
        nodes.push({ key: node.key, y, centerY });
        centerByKey.set(node.key, centerY);
        cursor += options.nodeHeight;
        if (nodeIndex < lane.nodes.length - 1) cursor += options.nodeGap;
      });
    }
    layoutLanes.push({
      stage: lane.stage,
      y: laneTop,
      height: cursor - laneTop,
      nodeCount: lane.nodes.length,
    });
    if (laneIndex < lanes.length - 1) cursor += options.laneGap;
  });

  const edges: FeatureFlowLayoutEdge[] = [];
  for (const lane of lanes) {
    for (const node of lane.nodes) {
      const fromY = centerByKey.get(node.key);
      if (fromY === undefined) continue;
      for (const dependsOnKey of node.dependsOnKeys) {
        const toY = centerByKey.get(dependsOnKey);
        if (toY === undefined) continue;
        edges.push({
          key: `${node.key}->${dependsOnKey}`,
          fromKey: node.key,
          toKey: dependsOnKey,
          path: connectorPath(fromY, toY, options.gutterWidth),
        });
      }
    }
  }

  return { height: cursor, lanes: layoutLanes, nodes, edges, options };
}

function connectorPath(fromY: number, toY: number, gutterWidth: number): string {
  const right = gutterWidth;
  const span = Math.abs(toY - fromY);
  // Bow depth is capped so a pipeline with tall gaps does not push its
  // connectors off the left edge of the rail.
  const depth = Math.min(gutterWidth - 3, 4 + span / 24);
  const controlX = right - depth;
  return `M ${right} ${fromY} C ${controlX} ${fromY} ${controlX} ${toY} ${right} ${toY}`;
}

/**
 * Which features changed lane since the last render, so the panel can flash
 * them as they arrive. Returns the next stage map alongside, because the caller
 * must store exactly what was compared against.
 */
export function diffFeatureStages(
  previous: ReadonlyMap<string, FeatureFlowStage>,
  sections: ReadonlyArray<FeatureFlowSection>,
): {
  readonly changed: ReadonlySet<string>;
  readonly stages: ReadonlyMap<string, FeatureFlowStage>;
} {
  const stages = new Map<string, FeatureFlowStage>();
  const changed = new Set<string>();
  for (const section of sections) {
    for (const lane of section.lanes) {
      for (const node of lane.nodes) {
        stages.set(node.key, node.stage);
        const before = previous.get(node.key);
        // A feature seen for the first time has not moved: it appeared. Flashing
        // it would make every panel open look like a merge just happened.
        if (before !== undefined && before !== node.stage) changed.add(node.key);
      }
    }
  }
  return { changed, stages };
}

/** Ordered stage progression, for reading "how far has this got" without git. */
export function featureFlowStageProgress(stage: FeatureFlowStage): number {
  return stageRank(stage) / (FEATURE_FLOW_LANE_STAGES.length - 1);
}
