import { createFileRoute } from "@tanstack/react-router";

import { SidebarInset } from "~/components/ui/sidebar";

import { ProjectHomeView } from "../components/projects/ProjectHomeView";

function ProjectHomeRouteView() {
  const { slug } = Route.useParams();
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <ProjectHomeView slug={slug} />
    </SidebarInset>
  );
}

// `projects_` rather than `projects`: the trailing underscore opts this route
// out of nesting under the index, so a project home replaces the grid rather
// than rendering inside it. Both still sit under `/_chat`.
//
// The slug is not validated here. A URL naming a project no machine knows is a
// real state — a removed project, or one that only exists on a machine that is
// offline — and the view distinguishes those two. A route-level guard could
// only turn both into a 404.
export const Route = createFileRoute("/_chat/projects_/$slug")({
  component: ProjectHomeRouteView,
});
