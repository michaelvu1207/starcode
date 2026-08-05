import { describe, expect, it } from "vite-plus/test";

import sidebarSource from "../SidebarV2.tsx?raw";
import promptSource from "../chat/ArchivedThreadPrompt.tsx?raw";
import headerSource from "./SidebarHeaderCompact.tsx?raw";
import settingsNavSource from "../settings/SettingsSidebarNav.tsx?raw";
import archivedSettingsRouteSource from "../../routes/settings.archived.tsx?raw";

describe("the sidebar archive surface", () => {
  it("lives in the compact icon row instead of Settings", () => {
    expect(headerSource).toContain('data-testid="sidebar-archive-toggle"');
    expect(headerSource).toContain("aria-pressed={showArchived}");
    expect(headerSource).toContain(
      'showArchived ? "Show active threads" : "Show archived threads"',
    );
    expect(settingsNavSource).not.toContain('to: "/settings/archived"');
    expect(archivedSettingsRouteSource).toContain('redirect({ to: "/settings/general"');
  });

  it("replaces active thread groupings with the archived snapshot", () => {
    const archiveBranch = sidebarSource.indexOf("if (showArchived)");
    const chatsBranch = sidebarSource.indexOf("if (showChats)");
    const connectionsBranch = sidebarSource.indexOf('if (viewMode === "connections")');

    expect(archiveBranch).toBeGreaterThan(-1);
    expect(archiveBranch).toBeLessThan(chatsBranch);
    expect(archiveBranch).toBeLessThan(connectionsBranch);
    expect(sidebarSource).toContain("useArchivedThreadSnapshots(environmentIds)");
    expect(sidebarSource).toContain('archiveMode={showArchived ? "unarchive" : "archive"}');
  });

  it("replaces archived chat content with a restore prompt", () => {
    expect(promptSource).toContain('data-testid="archived-thread-prompt"');
    expect(promptSource).toContain("This thread is archived.");
    expect(promptSource).toContain('"Unarchive thread"');
  });
});
