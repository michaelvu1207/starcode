import { ConnectionsSettings } from "./ConnectionsSettings";
import { SettingsPageContainer } from "./settingsLayout";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { Badge } from "../ui/badge";

export function ConnectionsAccountsPanel() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  return (
    <SettingsPageContainer className="max-w-none gap-2 px-2 py-2 sm:px-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,26rem),1fr))] items-start gap-2 px-1 sm:px-2">
        {environments.map((environment) => {
          const isPrimary = environment.environmentId === primaryEnvironmentId;
          const isConnected = environment.connection.phase === "connected";
          return (
            <section
              key={environment.environmentId}
              className="overflow-hidden rounded-lg border border-border/60 bg-muted/10"
            >
              <header className="flex h-9 items-center justify-between gap-2 border-b border-border/50 px-2.5">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{environment.label}</h3>
                </div>
                <div className="flex items-center gap-1.5">
                  {isPrimary ? <Badge size="sm">Current</Badge> : <Badge size="sm">Remote</Badge>}
                  <Badge size="sm" variant={isConnected ? "success" : "warning"}>
                    {isConnected ? "Connected" : environment.connection.phase}
                  </Badge>
                </div>
              </header>
              {isConnected ? (
                <div className="p-1">
                  <ConnectionsSettings
                    environmentId={environment.environmentId}
                    accountsOnly
                    fleetCompact
                  />
                </div>
              ) : (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  Connect this environment to inspect or change its accounts.
                </p>
              )}
            </section>
          );
        })}
      </div>
    </SettingsPageContainer>
  );
}
