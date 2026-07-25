import { createFileRoute } from "@tanstack/react-router";

import { SidebarInset } from "~/components/ui/sidebar";

import { ProjectsIndexView } from "../components/projects/ProjectsIndexView";

function ProjectsRouteView() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ProjectsIndexView />
    </SidebarInset>
  );
}

// Under `/_chat` for the same reasons `/workbench` is: the same auth gate, the
// same global shortcuts, the same sidebar. A static segment beats
// `$environmentId`, so `/projects` can never be read as a machine id.
export const Route = createFileRoute("/_chat/projects")({
  component: ProjectsRouteView,
});
