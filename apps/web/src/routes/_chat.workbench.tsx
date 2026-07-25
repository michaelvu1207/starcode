import { createFileRoute } from "@tanstack/react-router";

import { SidebarInset } from "~/components/ui/sidebar";

import { WorkbenchView } from "../components/workbench/WorkbenchView";

function WorkbenchRouteView() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <WorkbenchView />
    </SidebarInset>
  );
}

// Under `/_chat` rather than at the root so the Workbench inherits the same
// auth gate and global shortcuts every thread surface has. A static segment
// beats `$environmentId`, so `/workbench` can never be read as a machine id.
export const Route = createFileRoute("/_chat/workbench")({
  component: WorkbenchRouteView,
});
