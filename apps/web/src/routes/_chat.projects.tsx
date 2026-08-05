import { createFileRoute, redirect } from "@tanstack/react-router";

// The global projects index is gone (F16.6, Michael: *"There should not be a
// global projects view. That's not something that we really needed."*). The
// sidebar's projects view is the list now.
//
// The route stays, as a redirect rather than a deletion: `/projects` is a URL
// an operator may have kept, and a bookmark that 404s is a worse answer than
// the app's own landing page. Individual projects are unaffected — they live at
// `/projects/$slug`, which is its own route file (`projects_`) and was never
// nested under this one.
export const Route = createFileRoute("/_chat/projects")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
