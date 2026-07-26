/**
 * The writes the projects surfaces make, in the vocabulary those surfaces speak.
 *
 * Phase 2 shipped the transport — a fan-out that carries display fields to every
 * machine and machine-local fields to one. This is the layer above it: "seed
 * these proposals", "bind this folder", "rename this project". Each one is a
 * couple of calls into that transport plus a refresh, and having them in one
 * place is what keeps the components free of fan-out reasoning.
 *
 * Every write refreshes the machines it touched rather than waiting for the
 * 45-second poll. The optimistic overlay covers display changes in the
 * meantime; membership has no overlay, because the ids in it belong to a
 * machine and guessing at them is exactly what the split exists to prevent.
 */
import {
  toProjectCategorySlug,
  type EnvironmentId,
  type ProjectCategoryDisplayPatch,
  type ProjectCategorySlug,
  type ProjectId,
} from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironments } from "../../state/environments";
import {
  refreshProjectCatalogs,
  useForgetPendingProjectDisplay,
  useProjectCatalogView,
  useRemoveProjectCategory,
  useUpsertProjectCategory,
  type ProjectCatalogFanOutResult,
} from "../../state/projectCatalog";
import { projectSectionFor } from "./ProjectCatalog.model";
import type { ProjectBindSuggestion, ProjectSeedProposal } from "./ProjectCatalog.model";

export interface ProjectWriter {
  /** Creates each accepted proposal and binds it to the locations behind it. */
  readonly seed: (proposals: ReadonlyArray<ProjectSeedProposal>) => Promise<void>;
  /** Adds one location to one machine's record for a project. */
  readonly bind: (suggestion: ProjectBindSuggestion) => void;
  /** Creates an empty project from a name the operator typed. */
  readonly create: (title: string) => Promise<ProjectCategorySlug | null>;
  readonly rename: (slug: ProjectCategorySlug, patch: ProjectCategoryDisplayPatch) => Promise<void>;
  readonly setArchived: (slug: ProjectCategorySlug, archived: boolean) => Promise<void>;
  /**
   * Drops the category from every connected machine, and reports which ones
   * took it. Threads are untouched — a category is a label over threads that
   * live somewhere else, so removing it unfiles them and deletes nothing.
   */
  readonly remove: (slug: ProjectCategorySlug) => Promise<ProjectCatalogFanOutResult>;
  /**
   * Names this project's orchestrator on one machine, or clears it with an
   * empty id.
   *
   * Machine-local like every other id in the local half, and for a reason
   * beyond bookkeeping: the capability that carries the peer write tools is
   * minted by the machine hosting the thread, so a master designated anywhere
   * else would be a master with none of a master's tools.
   */
  readonly designateMaster: (
    slug: ProjectCategorySlug,
    environmentId: EnvironmentId,
    threadId: string,
  ) => Promise<void>;
}

export function useProjectWriter(): ProjectWriter {
  const view = useProjectCatalogView();
  const { environments } = useEnvironments();
  const upsert = useUpsertProjectCategory();
  const removeCategory = useRemoveProjectCategory();
  const forgetPending = useForgetPendingProjectDisplay();

  const connectedIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );

  const seed = useCallback(
    async (proposals: ReadonlyArray<ProjectSeedProposal>) => {
      for (const proposal of proposals) {
        // Display first, to every machine: the category has to exist before a
        // machine can bind a folder to it, and creating it on only the machines
        // that hold a location would leave the others unable to file anything
        // into it later without re-creating it.
        await upsert({
          slug: proposal.slug,
          display: { title: proposal.title },
          created: true,
        });

        // Then one local write per machine that contributed a location. Grouped
        // per machine because bindings replace the whole set, so two locations
        // on the same machine must arrive together or the second would drop the
        // first.
        const byEnvironment = new Map<EnvironmentId, Array<ProjectId>>();
        for (const location of proposal.locations) {
          const bucket = byEnvironment.get(location.environmentId);
          if (bucket === undefined) byEnvironment.set(location.environmentId, [location.projectId]);
          else bucket.push(location.projectId);
        }
        for (const [environmentId, projectIds] of byEnvironment) {
          await upsert({
            slug: proposal.slug,
            local: { environmentId, patch: { bindings: projectIds } },
            environmentIds: [],
          });
        }
      }
      refreshProjectCatalogs(connectedIds);
    },
    [connectedIds, upsert],
  );

  const bind = useCallback(
    (suggestion: ProjectBindSuggestion) => {
      const project = view.projects.find((entry) => entry.slug === suggestion.slug);
      if (project === undefined) return;
      // Append rather than replace: the patch carries the whole set, so the
      // machine's existing bindings have to travel with the new one.
      const existing = projectSectionFor(project, suggestion.location.environmentId).bindings.map(
        (binding) => binding.projectId,
      );
      if (existing.includes(suggestion.location.projectId)) return;
      void upsert({
        slug: suggestion.slug,
        local: {
          environmentId: suggestion.location.environmentId,
          patch: { bindings: [...existing, suggestion.location.projectId] },
        },
        environmentIds: [],
      }).then(() => refreshProjectCatalogs([suggestion.location.environmentId]));
    },
    [upsert, view.projects],
  );

  const create = useCallback(
    async (title: string) => {
      const base = toProjectCategorySlug(title);
      if (base === null) return null;
      // A name the operator typed can collide with a project that already
      // exists. Suffixing here matches what seeding does, so the two paths
      // cannot disagree about what "already taken" means.
      const taken = new Set(view.projects.map((project) => project.slug));
      let slug = base;
      let suffix = 2;
      while (taken.has(slug)) {
        slug = `${base}-${suffix}` as ProjectCategorySlug;
        suffix += 1;
      }
      const result = await upsert({ slug, display: { title: title.trim() }, created: true });
      // Nowhere took it. Without this the optimistic overlay would keep
      // rendering a project that exists on no machine — a ghost the operator
      // can open, name and file threads into, none of which goes anywhere.
      if (result.acceptedEnvironmentIds.length === 0) {
        forgetPending(slug);
        return null;
      }
      refreshProjectCatalogs(connectedIds);
      return slug;
    },
    [connectedIds, forgetPending, upsert, view.projects],
  );

  const rename = useCallback(
    async (slug: ProjectCategorySlug, patch: ProjectCategoryDisplayPatch) => {
      await upsert({ slug, display: patch, environmentIds: connectedIds });
      refreshProjectCatalogs(connectedIds);
    },
    [connectedIds, upsert],
  );

  const setArchived = useCallback(
    async (slug: ProjectCategorySlug, archived: boolean) => {
      await upsert({
        slug,
        display: { archivedAt: archived ? new Date().toISOString() : null },
        environmentIds: connectedIds,
      });
      refreshProjectCatalogs(connectedIds);
    },
    [connectedIds, upsert],
  );

  const remove = useCallback(
    async (slug: ProjectCategorySlug) => {
      const result = await removeCategory({ slug, environmentIds: connectedIds });
      // Refresh the machines that took it, not all of them: a machine that
      // refused still holds the category, and re-reading it would only put the
      // category straight back on screen with no explanation. The caller is
      // holding the refusals and is the one that can explain them.
      refreshProjectCatalogs(result.acceptedEnvironmentIds);
      return result;
    },
    [connectedIds, removeCategory],
  );

  const designateMaster = useCallback(
    async (slug: ProjectCategorySlug, environmentId: EnvironmentId, threadId: string) => {
      await upsert({
        slug,
        local: { environmentId, patch: { masterThreadId: threadId } },
        environmentIds: [],
      });
      refreshProjectCatalogs([environmentId]);
    },
    [upsert],
  );

  return useMemo(
    () => ({ seed, bind, create, rename, setArchived, remove, designateMaster }),
    [bind, create, designateMaster, remove, rename, seed, setArchived],
  );
}
