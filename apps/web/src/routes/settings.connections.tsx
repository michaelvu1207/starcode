import { createFileRoute } from "@tanstack/react-router";

import { ConnectionsAccountsPanel } from "../components/settings/ConnectionsAccountsPanel";

export const Route = createFileRoute("/settings/connections")({
  component: ConnectionsAccountsPanel,
});
