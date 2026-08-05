import { createFileRoute } from "@tanstack/react-router";

import { AccountsUsagePanel } from "../components/usage/AccountsUsagePanel";

function SettingsUsageRoute() {
  return <AccountsUsagePanel />;
}

export const Route = createFileRoute("/settings/usage")({
  component: SettingsUsageRoute,
});
