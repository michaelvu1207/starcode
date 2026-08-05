import { createFileRoute } from "@tanstack/react-router";

import { AccountsUsagePanel } from "../components/usage/AccountsUsagePanel";

function SettingsProvidersRoute() {
  return <AccountsUsagePanel />;
}

export const Route = createFileRoute("/settings/providers")({
  component: SettingsProvidersRoute,
});
