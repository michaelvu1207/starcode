/**
 * Web-side project catalog: the folded view, and the fan-out that writes it.
 *
 * The read half instantiates the client-runtime atom families once against the
 * connection runtime, exactly as `state/featureFlow.ts` does, and folds every
 * machine's answer through `ProjectCatalog.model.ts`.
 *
 * The write half is the part with an opinion. There is no hub server, so
 * "create a project everywhere" is the *client* issuing the same display write
 * to every reachable machine — the same loop it already runs to read them.
 * Machine-local writes (bindings, filed threads, this machine's master) go to
 * exactly one machine, because the ids in them mean nothing anywhere else.
 *
 * A fan-out reports per machine rather than succeeding or failing as a whole. A
 * laptop that was asleep during a rename is a normal state that heals on the
 * next write, and collapsing that into "the rename failed" would be both wrong
 * and unhelpful.
 */
import {
  createEnvironmentProjectCatalogAtoms,
  createEnvironmentProjectCatalogLocationsAtom,
  createEnvironmentProjectCatalogSnapshotsAtom,
  type ProjectCatalogWriteOutcome,
} from "@t3tools/client-runtime/state/project-catalog";
import type {
  EnvironmentId,
  ProjectCatalogFileThreadRequest,
  ProjectCategoryDisplayPatch,
  ProjectCategoryLocalPatch,
  ProjectCategorySlug,
} from "@t3tools/contracts";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { useCallback, useMemo } from "react";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  applyPendingProjectDisplays,
  buildProjectCatalogView,
  buildProjectSeedPlan,
  type PendingProjectDisplay,
  type ProjectCatalogView,
  type ProjectSeedLocation,
  type ProjectSeedPlan,
} from "../components/projects/ProjectCatalog.model";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironments, usePrimaryEnvironmentId } from "./environments";
import { environmentServerConfigsAtom } from "./server";
import { useAtomCommand } from "./use-atom-command";

export const environmentProjectCatalog =
  createEnvironmentProjectCatalogAtoms(connectionAtomRuntime);

export const environmentProjectCatalogSnapshotsAtom = createEnvironmentProjectCatalogSnapshotsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotValueAtom: environmentProjectCatalog.snapshotValueAtom,
});

export const environmentProjectCatalogLocationsAtom = createEnvironmentProjectCatalogLocationsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  locationsValueAtom: environmentProjectCatalog.locationsValueAtom,
});

/**
 * Display writes issued but not yet read back.
 *
 * A module-level atom rather than component state because the write is fired
 * from one surface (a dialog, a menu) and rendered by another (the index, a
 * project home), and both have to see it. Entries clear themselves — see
 * `applyPendingProjectDisplays` — so nothing here has to be swept.
 */
const pendingProjectDisplaysAtom = Atom.make<ReadonlyArray<PendingProjectDisplay>>([]);

/**
 * Every machine's catalog, folded into one set of projects.
 *
 * The two absence signals are the ones the feature-flow panel learned to keep
 * apart, and they matter more here: a machine that is not connected is pending
 * and must not be blamed, while a connected machine that does not advertise the
 * capability is mid-rollout and the view names it. Note what "connected" does
 * not require — a decoded `ServerConfig`. Keying "pending" off a missing
 * descriptor made machines vanish from the feature-flow panel entirely, and
 * silence about a machine you are connected to is the one answer a projects
 * view must never give.
 */
export function useProjectCatalogView(): ProjectCatalogView {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const snapshots = useAtomValue(environmentProjectCatalogSnapshotsAtom);
  const pending = useAtomValue(pendingProjectDisplaysAtom);

  const read = useMemo(
    () =>
      buildProjectCatalogView(
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          isLocal: environment.environmentId === primaryEnvironmentId,
          snapshot: snapshots.get(environment.environmentId) ?? null,
          supported:
            serverConfigs.get(environment.environmentId)?.environment.capabilities
              .projectCatalog === true,
          pending: environment.connection.phase !== "connected",
        })),
      ),
    [environments, primaryEnvironmentId, serverConfigs, snapshots],
  );

  return useMemo(() => applyPendingProjectDisplays(read, pending), [pending, read]);
}

/** Every machine's bindable locations, flattened and labelled by machine. */
export function useProjectCatalogLocations(): ReadonlyArray<ProjectSeedLocation> {
  const { environments } = useEnvironments();
  const pages = useAtomValue(environmentProjectCatalogLocationsAtom);

  return useMemo(
    () =>
      environments.flatMap((environment) => {
        const page = pages.get(environment.environmentId);
        if (page === undefined) return [];
        return page.locations.map(
          (location): ProjectSeedLocation => ({
            ...location,
            environmentId: environment.environmentId,
            label: environment.label,
          }),
        );
      }),
    [environments, pages],
  );
}

/** What first-open should propose, and what a later open should suggest. */
export function useProjectSeedPlan(view: ProjectCatalogView): ProjectSeedPlan {
  const locations = useProjectCatalogLocations();
  return useMemo(
    () => buildProjectSeedPlan({ projects: view.projects, locations }),
    [locations, view.projects],
  );
}

/** One machine's answer to one write. */
export interface ProjectCatalogWriteReport {
  readonly environmentId: EnvironmentId;
  readonly outcome: ProjectCatalogWriteOutcome<unknown>;
}

export interface ProjectCatalogFanOutResult {
  readonly reports: ReadonlyArray<ProjectCatalogWriteReport>;
  /** Machines that took the write. Empty means nothing converged anywhere. */
  readonly acceptedEnvironmentIds: ReadonlyArray<EnvironmentId>;
  /** Machines that could not, with a sentence each. */
  readonly refusals: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly message: string;
  }>;
}

const summarize = (
  reports: ReadonlyArray<ProjectCatalogWriteReport>,
): ProjectCatalogFanOutResult => ({
  reports,
  acceptedEnvironmentIds: reports
    .filter((report) => report.outcome.kind === "ok")
    .map((report) => report.environmentId),
  refusals: reports
    .filter((report) => report.outcome.kind !== "ok")
    .map((report) => ({
      environmentId: report.environmentId,
      message: report.outcome.kind === "ok" ? "" : report.outcome.message,
    })),
});

/**
 * Writes a category's display half to every machine, and its local half to one.
 *
 * The single authoring timestamp is the point: the client stamps `now` once and
 * sends the same value to all four machines, so the fold's last-writer-wins
 * comparison converges on the operator's clock rather than racing four clocks
 * against each other. Without it, a rename would "win" on whichever machine
 * happened to run fastest.
 */
export function useUpsertProjectCategory(): (input: {
  readonly slug: ProjectCategorySlug;
  readonly display?: ProjectCategoryDisplayPatch;
  /** The machine the local half belongs to. Omit for a display-only write. */
  readonly local?: {
    readonly environmentId: EnvironmentId;
    readonly patch: ProjectCategoryLocalPatch;
  };
  /**
   * Machines to carry the display half to. Defaults to every connected
   * machine, which is what create, rename and archive all want.
   */
  readonly environmentIds?: ReadonlyArray<EnvironmentId>;
  /** The write creates the category, so render it before any machine reports it. */
  readonly created?: boolean;
}) => Promise<ProjectCatalogFanOutResult> {
  const { environments } = useEnvironments();
  const setPending = useAtomSet(pendingProjectDisplaysAtom);
  const run = useAtomCommand(environmentProjectCatalog.upsertCommand, {
    label: "web:project-catalog:upsert",
    // The loader turns every refusal into a value, so the command's failure
    // channel only ever carries a defect — and the caller reports per machine
    // anyway, which says more than a toast would.
    reportFailure: false,
  });
  const connectedIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );

  return useCallback(
    async (input) => {
      const displayUpdatedAt = new Date().toISOString();
      const displayPatch = input.display;
      const targets = new Set(
        input.environmentIds ?? (displayPatch === undefined ? [] : connectedIds),
      );
      if (input.local !== undefined) targets.add(input.local.environmentId);

      // Recorded before the requests rather than after them: the point of the
      // overlay is that the new title is on screen while the fan-out is still
      // in flight.
      if (displayPatch !== undefined) {
        setPending((entries) => [
          ...entries.filter((entry) => entry.slug !== input.slug),
          {
            slug: input.slug,
            display: displayPatch,
            stamp: displayUpdatedAt,
            created: input.created ?? false,
          },
        ]);
      }

      const reports = await Promise.all(
        [...targets].map(async (environmentId): Promise<ProjectCatalogWriteReport> => {
          const result = await run({
            environmentId,
            input: {
              request: {
                slug: input.slug,
                ...(displayPatch === undefined ? {} : { display: displayPatch }),
                // The local half goes to exactly one machine. Sending it
                // anywhere else would file this machine's thread ids into
                // another machine's registry, where they name nothing.
                ...(input.local !== undefined && input.local.environmentId === environmentId
                  ? { local: input.local.patch }
                  : {}),
                displayUpdatedAt,
              },
            },
          });
          return {
            environmentId,
            outcome: AsyncResult.isSuccess(result)
              ? result.value
              : { kind: "unavailable", message: "The machine could not be reached." },
          };
        }),
      );
      return summarize(reports);
    },
    [connectedIds, run, setPending],
  );
}

/**
 * Drops a category. Fans out for the same reason create does — a category that
 * survives on one machine reappears in the fold on the next poll.
 */
export function useRemoveProjectCategory(): (input: {
  readonly slug: ProjectCategorySlug;
  readonly environmentIds?: ReadonlyArray<EnvironmentId>;
}) => Promise<ProjectCatalogFanOutResult> {
  const { environments } = useEnvironments();
  const setPending = useAtomSet(pendingProjectDisplaysAtom);
  const run = useAtomCommand(environmentProjectCatalog.removeCommand, {
    label: "web:project-catalog:remove",
    reportFailure: false,
  });
  const connectedIds = useMemo(
    () =>
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => environment.environmentId),
    [environments],
  );

  return useCallback(
    async (input) => {
      // A category created a moment ago and removed before any machine
      // reported it would otherwise sit in the overlay with nothing left to
      // clear it.
      setPending((entries) => entries.filter((entry) => entry.slug !== input.slug));

      const reports = await Promise.all(
        (input.environmentIds ?? connectedIds).map(
          async (environmentId): Promise<ProjectCatalogWriteReport> => {
            const result = await run({ environmentId, input: { slug: input.slug } });
            return {
              environmentId,
              outcome: AsyncResult.isSuccess(result)
                ? result.value
                : { kind: "unavailable", message: "The machine could not be reached." },
            };
          },
        ),
      );
      return summarize(reports);
    },
    [connectedIds, run, setPending],
  );
}

/**
 * Files, excludes, or unfiles one thread — on the machine that owns it, and
 * only there. A thread id is machine-local, so there is nothing to fan out.
 */
export function useFileThreadIntoProject(): (input: {
  readonly environmentId: EnvironmentId;
  readonly request: ProjectCatalogFileThreadRequest;
}) => Promise<ProjectCatalogWriteOutcome<unknown>> {
  const run = useAtomCommand(environmentProjectCatalog.fileThreadCommand, {
    label: "web:project-catalog:file-thread",
    reportFailure: false,
  });
  return useCallback(
    async (input) => {
      const result = await run({
        environmentId: input.environmentId,
        input: { request: input.request },
      });
      return AsyncResult.isSuccess(result)
        ? result.value
        : { kind: "unavailable", message: "The machine could not be reached." };
    },
    [run],
  );
}

/**
 * Re-reads one machine's catalog now.
 *
 * A write is optimistic only in the sense that the poll is 45 seconds away —
 * the caller refreshes the machines it just wrote to so the view reflects the
 * write immediately rather than on the next tick.
 */
export function useRefreshProjectCatalog(environmentId: EnvironmentId | null): () => void {
  const refresh = useAtomRefresh(
    environmentProjectCatalog.snapshotAtom(environmentId ?? PLACEHOLDER_ENVIRONMENT_ID),
  );
  return environmentId === null ? NOOP : refresh;
}

const NOOP = () => {};
/**
 * `useAtomRefresh` cannot be called conditionally, so a null environment still
 * needs an atom to point at. This id belongs to no machine, so the atom it keys
 * is never fetched — only ever refreshed into the void by the no-op above.
 */
const PLACEHOLDER_ENVIRONMENT_ID = "project-catalog-no-environment" as EnvironmentId;
