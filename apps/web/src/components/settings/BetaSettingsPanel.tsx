import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function BetaSettingsPanel() {
  const sidebarV2Enabled = useClientSettings((settings) => settings.sidebarV2Enabled);
  const updateSettings = useUpdateClientSettings();

  return (
    <SettingsPageContainer>
      <SettingsSection title="Beta features">
        <SettingsRow
          title="Sidebar v2"
          description="One flat thread list across every connected machine, ranked so threads waiting on you sit at the top. Ordering is switchable from the sidebar's sort menu. Switch back any time."
          control={
            <Switch
              checked={sidebarV2Enabled}
              onCheckedChange={(checked) => updateSettings({ sidebarV2Enabled: Boolean(checked) })}
              aria-label="Enable the sidebar v2 beta"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
