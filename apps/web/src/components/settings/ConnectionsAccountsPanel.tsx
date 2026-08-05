import { ConnectionsSettings } from "./ConnectionsSettings";
import { SettingsPageContainer } from "./settingsLayout";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";

export function ConnectionsAccountsPanel() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  if (!primaryEnvironmentId) {
    return (
      <SettingsPageContainer className="max-w-none px-3 py-3">
        <p className="text-sm text-muted-foreground">Connecting to Starcode…</p>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer className="max-w-none gap-2 px-2 py-2 sm:px-3">
      <ConnectionsSettings
        environmentId={primaryEnvironmentId}
        accountsOnly
        fleetCompact
        assignmentEnvironments={environments}
      />
    </SettingsPageContainer>
  );
}
