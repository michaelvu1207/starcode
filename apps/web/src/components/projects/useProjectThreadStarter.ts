/**
 * Starting a thread that is already this project's.
 *
 * Two steps, and the order matters. First the ordinary new-thread flow, at a
 * folder on a machine — a thread has to have a cwd, and nothing here changes
 * how one is made. Then the new thread is filed into the category by id.
 *
 * The filing is deliberate rather than incidental. If the folder is bound, the
 * thread would be a member anyway and the write is redundant; if it is not
 * bound, the write is the only thing that makes it one. Doing it unconditionally
 * means "New thread" behaves the same in both cases, which is worth one
 * redundant write — the alternative is an affordance that silently does nothing
 * on exactly the projects most likely to need it, the hand-made ones with no
 * folder yet.
 *
 * ⚠️ The id being filed belongs to a DRAFT. `useNewThreadHandler` mints the
 * thread id on the client and the thread does not exist on any server until the
 * first message is sent, so this files an id the machine has never heard of.
 * That is safe in both directions and both halves are load-bearing: the
 * registry stores thread ids as an opaque list and validates nothing, and the
 * sidebar fold already skips filed ids it has no shell for
 * (`Sidebar.projects.ts`, `rowsFor`). So an abandoned draft leaves one dead id
 * in a registry file and nothing else, and a draft that is sent appears under
 * its project without a second write.
 *
 * The created draft is recovered from the router rather than returned, which is
 * the idiom `ProjectHomeView.createMaster` already uses: the handler navigates
 * to `/draft/$draftId`, so the current route names what it just made. Reading
 * it back keeps `useHandleNewThread` — a hook every new-thread path in the app
 * goes through — out of this feature entirely.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ProjectCategorySlug, ThreadId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { refreshProjectCatalogs, useFileThreadIntoProject } from "../../state/projectCatalog";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import type { ProjectStartLocation } from "./ProjectThreadStart.model";

export function useProjectThreadStarter(): (
  slug: ProjectCategorySlug,
  location: ProjectStartLocation,
) => Promise<void> {
  const handleNewThread = useNewThreadHandler();
  const fileThread = useFileThreadIntoProject();
  const router = useRouter();

  return useCallback(
    async (slug, location) => {
      await handleNewThread(scopeProjectRef(location.environmentId, location.projectId));

      const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const target = resolveThreadRouteTarget(params);
      // No draft on the route means the handler reused something that is not a
      // draft, or navigation did not happen. The thread still exists and is
      // still in the right folder — it just cannot be filed by id, so a bound
      // folder carries it and an unbound one leaves it in Chats. Better than
      // filing whatever id happens to be on the route.
      if (target?.kind !== "draft") return;
      const draft = useComposerDraftStore.getState().getDraftThread(target.draftId);
      if (draft === null) return;

      await fileThread({
        environmentId: location.environmentId,
        request: { mode: "assign", threadId: draft.threadId as ThreadId, slug },
      });
      refreshProjectCatalogs([location.environmentId]);
    },
    [fileThread, handleNewThread, router],
  );
}
