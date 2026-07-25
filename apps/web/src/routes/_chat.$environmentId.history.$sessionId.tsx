import { createFileRoute } from "@tanstack/react-router";
import type { EnvironmentId, HistorySessionId } from "@t3tools/contracts";

import { SidebarInset } from "~/components/ui/sidebar";
import { HistoryTranscriptView } from "../components/history/HistoryTranscriptView";
import { useEnvironment } from "../state/environments";

/**
 * Read-only terminal-history viewer, in the pane where ChatView normally sits.
 *
 * Inherits `_chat`'s auth gate and sidebar layout for free. `history` is a
 * static segment one level deeper than `$threadId`, so the two never collide.
 */
function HistoryTranscriptRouteView() {
  const params = Route.useParams();
  // Branded at the boundary, matching `threadRoutes.ts`. The session id is not
  // trusted here on purpose: the server re-validates its shape and resolves it
  // only through its own index, so a hand-typed URL is a 404, not a read.
  const environmentId = params.environmentId as EnvironmentId;
  const environment = useEnvironment(environmentId);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <HistoryTranscriptView
        environmentId={environmentId}
        sessionId={params.sessionId as HistorySessionId}
        machineLabel={environment?.label ?? "this machine"}
        ready={environment !== null && environment !== undefined}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/history/$sessionId")({
  component: HistoryTranscriptRouteView,
});
