/**
 * Fork-owned: what a project card says.
 *
 * The index exists to answer one question in a glance — *which project has an
 * agent waiting on me* — and everything on a card is subordinate to that. So
 * the rollup is computed from state the client already holds (thread shells and
 * the feature-flow view), not from anything new on the wire, and the attention
 * count is the field the sort is built around.
 *
 * Pure, and separate from `ProjectCatalog.model.ts`, which answers a different
 * question: that file decides *what a project is* across four machines, this
 * one decides what one project looks like today. Keeping them apart means the
 * fold's tests never have to construct a thread.
 *
 * @module ProjectsIndexModel
 */
import type { FeatureFlowStage, ProjectCategorySlug } from "@t3tools/contracts";

import type { SidebarV2Status } from "../Sidebar.logic";
import type { FeatureFlowView } from "../workbench/FeatureFlow.model";
import { toneForThreadStatus, type WorkbenchTone } from "../workbench/Workbench.tone";
import {
  projectThreadKey,
  type ProjectCategoryView,
  type ProjectMembership,
} from "./ProjectCatalog.model";

/** A thread, reduced to what a card needs. */
export interface ProjectRollupThread {
  readonly environmentId: string;
  readonly id: string;
  readonly title: string;
  readonly status: SidebarV2Status;
  readonly updatedAt: string;
  /** Settled work is still the project's, but it is not what the card counts. */
  readonly settled: boolean;
}

export interface ProjectStageRollup {
  readonly inProgress: number;
  readonly inDev: number;
  readonly inStaging: number;
  readonly inProduction: number;
}

export interface ProjectMachineChip {
  readonly environmentId: string;
  readonly label: string;
  readonly isLocal: boolean;
  /** This machine binds a location or names a master — it carries real work. */
  readonly carriesWork: boolean;
}

export interface ProjectCard {
  readonly slug: ProjectCategorySlug;
  readonly title: string;
  readonly summary: string;
  /** Chosen accent id, or empty for the one derived from the slug. */
  readonly accent: string;
  /** Chosen glyph variant, or empty for the one derived from the slug. */
  readonly glyph: string;
  readonly archived: boolean;
  readonly machines: ReadonlyArray<ProjectMachineChip>;
  readonly activeCount: number;
  readonly settledCount: number;
  /**
   * Threads whose agent stopped and is waiting on a human — approvals and
   * questions. The reason to open the index at all.
   */
  readonly attentionCount: number;
  readonly workingCount: number;
  /** Worst-news-first, for the card's dot. */
  readonly tone: WorkbenchTone;
  readonly stages: ProjectStageRollup;
  readonly lastActivityAt: string | null;
  /** Machines whose copy of the title is behind. Surfaced, never hidden. */
  readonly staleEnvironmentIds: ReadonlyArray<string>;
}

const EMPTY_STAGES: ProjectStageRollup = {
  inProgress: 0,
  inDev: 0,
  inStaging: 0,
  inProduction: 0,
};

/**
 * The one that matters most, first.
 *
 * A project with an agent waiting on a human is the project to open, even if
 * something else in it is failing — the failure will still be there in a
 * minute, and the waiting agent will not have moved.
 */
const TONE_RANK: ReadonlyArray<WorkbenchTone> = [
  "attention",
  "input",
  "failed",
  "working",
  "done",
  "quiet",
];

function worstTone(tones: ReadonlyArray<WorkbenchTone>): WorkbenchTone {
  for (const tone of TONE_RANK) {
    if (tones.includes(tone)) return tone;
  }
  return "quiet";
}

function countStages(stages: ReadonlyArray<FeatureFlowStage>): ProjectStageRollup {
  let inProgress = 0;
  let inDev = 0;
  let inStaging = 0;
  let inProduction = 0;
  for (const stage of stages) {
    if (stage === "in-dev") inDev += 1;
    else if (stage === "in-staging") inStaging += 1;
    else if (stage === "in-production") inProduction += 1;
    else inProgress += 1;
  }
  return { inProgress, inDev, inStaging, inProduction };
}

/**
 * Builds one card per project.
 *
 * Membership comes in already resolved, so this never re-derives which thread
 * belongs where — there is exactly one implementation of that rule and it is
 * in `ProjectCatalog.model.ts`.
 */
export function buildProjectCards(input: {
  readonly projects: ReadonlyArray<ProjectCategoryView>;
  readonly membership: ProjectMembership;
  readonly threads: ReadonlyArray<ProjectRollupThread>;
  /** Stage per scoped thread key, from the feature-flow view. */
  readonly flow: FeatureFlowView | null;
}): ReadonlyArray<ProjectCard> {
  const threadByKey = new Map(input.threads.map((thread) => [projectThreadKey(thread), thread]));
  const stageByKey = new Map(
    (input.flow?.features ?? []).map((feature) => [feature.key, feature.stage] as const),
  );

  return input.projects.map((project): ProjectCard => {
    const threadKeys = input.membership.threadKeysBySlug.get(project.slug) ?? [];

    const active: Array<ProjectRollupThread> = [];
    let settledCount = 0;
    for (const key of threadKeys) {
      const thread = threadByKey.get(key);
      if (thread === undefined) continue;
      if (thread.settled) settledCount += 1;
      else active.push(thread);
    }

    const tones = active.map((thread) => toneForThreadStatus(thread.status));
    const lastActivityAt = threadKeys
      .map((key) => threadByKey.get(key)?.updatedAt)
      .filter((value): value is string => value !== undefined)
      .reduce<string | null>(
        (latest, value) => (latest === null || value > latest ? value : latest),
        null,
      );

    return {
      slug: project.slug,
      title: project.display.title,
      summary: project.display.summary,
      accent: project.display.accent,
      glyph: project.display.glyph,
      archived: project.archived,
      machines: project.sections.map(
        (section): ProjectMachineChip => ({
          environmentId: section.environmentId,
          label: section.label,
          isLocal: section.isLocal,
          // A machine with a record but no binding and no master has been told
          // the project exists and nothing more. The chip says so by weight
          // rather than by being absent, because "known here, empty here" is a
          // different fact from "never heard of it".
          carriesWork:
            section.local.bindings.length > 0 ||
            section.local.threadIds.length > 0 ||
            section.local.masterThreadId.length > 0,
        }),
      ),
      activeCount: active.length,
      settledCount,
      attentionCount: tones.filter((tone) => tone === "attention" || tone === "input").length,
      workingCount: tones.filter((tone) => tone === "working").length,
      tone: worstTone(tones),
      stages:
        input.flow === null
          ? EMPTY_STAGES
          : countStages(
              threadKeys
                .map((key) => stageByKey.get(key))
                .filter((stage): stage is FeatureFlowStage => stage !== undefined),
            ),
      lastActivityAt,
      staleEnvironmentIds: project.staleEnvironmentIds,
    };
  });
}

/**
 * Cards in the order they should be read: whoever is waiting on you, then
 * whatever is moving, then everything else by recency.
 *
 * Archived projects sink below the rest rather than being dropped — the caller
 * puts them behind a disclosure, and sorting them out here would make that
 * decision twice.
 */
export function sortProjectCards(cards: ReadonlyArray<ProjectCard>): ReadonlyArray<ProjectCard> {
  return cards.toSorted((left, right) => {
    if (left.archived !== right.archived) return left.archived ? 1 : -1;
    if (left.attentionCount !== right.attentionCount) {
      return right.attentionCount - left.attentionCount;
    }
    if (left.workingCount !== right.workingCount) return right.workingCount - left.workingCount;
    if (left.lastActivityAt !== right.lastActivityAt) {
      if (left.lastActivityAt === null) return 1;
      if (right.lastActivityAt === null) return -1;
      return right.lastActivityAt.localeCompare(left.lastActivityAt);
    }
    return left.title.localeCompare(right.title) || left.slug.localeCompare(right.slug);
  });
}

/**
 * The constellation glyph, seeded from the slug.
 *
 * Uses F14's own FNV-1a rather than a second hash, and for the same reason that
 * file gives: any stable hash would do, what matters is that it is *this*
 * function forever, because changing it redraws every project at once.
 *
 * The result is a handful of points in a unit box plus the edges between them —
 * a constellation, not a picture. Deterministic across machines, so the same
 * project is the same shape everywhere.
 */
export interface ProjectGlyph {
  readonly points: ReadonlyArray<{ readonly x: number; readonly y: number; readonly r: number }>;
  readonly edges: ReadonlyArray<{
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  }>;
}

function fnv1a(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A stable value in [0, 1) from one slice of the hash. */
function slice(hash: number, index: number): number {
  const mixed = Math.imul(hash ^ Math.imul(index + 1, 0x9e3779b1), 0x85ebca6b) >>> 0;
  return mixed / 0x1_0000_0000;
}

/**
 * The seed a project's constellation is drawn from.
 *
 * Empty `glyph` means "whatever the slug gives", which is what every project
 * starts as and what most stay. A chosen variant is a suffix on the same seed
 * rather than a second hash, so picking one moves the figure without moving it
 * anywhere a different project already is.
 */
export function projectGlyphSeed(slug: string, glyph: string): string {
  return glyph.length === 0 ? slug : `${slug}#${glyph}`;
}

/**
 * The variants offered when an operator wants a different figure.
 *
 * Six, because the point is "not that one" rather than "exactly this one" — a
 * page of forty constellations is a decision nobody wants to make about a
 * project they just created.
 */
export const PROJECT_GLYPH_VARIANTS: ReadonlyArray<string> = ["", "2", "3", "4", "5", "6"];

export function projectGlyph(slug: string): ProjectGlyph {
  const hash = fnv1a(slug);
  // Four to six stars. Fewer reads as an accident, more stops being legible at
  // the size a card renders it.
  const count = 4 + Math.floor(slice(hash, 0) * 3);
  const points = Array.from({ length: count }, (_, index) => ({
    // Inset from the edges so a star is never clipped by the glyph's box.
    x: 0.16 + slice(hash, index * 3 + 1) * 0.68,
    y: 0.16 + slice(hash, index * 3 + 2) * 0.68,
    r: 0.045 + slice(hash, index * 3 + 3) * 0.05,
  }));

  // A path through the points in order, not a mesh: a constellation is a line
  // somebody traced, and every-pair edges would render as a blob.
  const edges = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return { x1: previous.x, y1: previous.y, x2: point.x, y2: point.y };
  });

  return { points, edges };
}

/**
 * The accents an operator can choose between.
 *
 * Every one is a rotation applied to the theme's own gold rather than a literal
 * colour, so a project cannot be given something that sits outside the palette
 * or comes out neon in one theme and muddy in the other. Named for the hue they
 * land on, not for the number of degrees, because the degrees are an
 * implementation detail of `hue-rotate` and the names are what the picker says.
 */
export interface ProjectAccentChoice {
  readonly id: string;
  readonly label: string;
  readonly hue: number;
}

export const PROJECT_ACCENTS: ReadonlyArray<ProjectAccentChoice> = [
  { id: "gold", label: "Gold", hue: 0 },
  { id: "ember", label: "Ember", hue: 315 },
  { id: "rose", label: "Rose", hue: 285 },
  { id: "iris", label: "Iris", hue: 240 },
  { id: "sky", label: "Sky", hue: 180 },
  { id: "jade", label: "Jade", hue: 105 },
];

/**
 * The hue rotation a project renders at.
 *
 * An unset accent — every project's starting state — is derived from the slug,
 * so a fresh grid is already distinguishable before anyone has chosen anything.
 * A chosen one is honoured exactly, and an accent this build does not know
 * falls back to the derived hue rather than to grey: an id written by a newer
 * client is not a reason to make a project look broken.
 */
export function projectAccentHue(slug: string, accent?: string): number {
  if (accent !== undefined && accent.length > 0) {
    const choice = PROJECT_ACCENTS.find((entry) => entry.id === accent);
    if (choice !== undefined) return choice.hue;
  }
  return Math.round(slice(fnv1a(slug), 7) * 360);
}
