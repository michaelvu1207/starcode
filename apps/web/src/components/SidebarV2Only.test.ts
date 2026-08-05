import { describe, expect, it } from "vite-plus/test";

import appSidebarLayoutSource from "./AppSidebarLayout.tsx?raw";
import sidebarSource from "./SidebarV2.tsx?raw";
import settingsNavSource from "./settings/SettingsSidebarNav.tsx?raw";
import chatRouteSource from "../routes/_chat.tsx?raw";
import retiredBetaRouteSource from "../routes/settings.beta.tsx?raw";

describe("the app has one sidebar implementation", () => {
  it("always mounts SidebarV2 and has no version gate or theme fork", () => {
    expect(appSidebarLayoutSource).toContain('import ThreadSidebar from "./SidebarV2"');
    expect(appSidebarLayoutSource).not.toContain('from "./Sidebar"');
    expect(appSidebarLayoutSource).not.toContain("sidebarV2Enabled");
    expect(appSidebarLayoutSource).not.toContain("data-sidebar-version");
    expect(appSidebarLayoutSource.split("<ThreadSidebar />")).toHaveLength(2);
  });

  it("keeps settings navigation inside the mounted sidebar", () => {
    expect(sidebarSource).toContain('pathname.startsWith("/settings/")');
    expect(sidebarSource).toContain("<SettingsSidebarNav pathname={pathname} />");
    expect(sidebarSource).toContain("<SidebarChromeHeader isElectron={isElectron} />");
  });

  it("retires the sidebar beta surface and keeps old links recoverable", () => {
    expect(settingsNavSource).not.toContain('"/settings/beta"');
    expect(settingsNavSource).not.toContain("FlaskConicalIcon");
    expect(retiredBetaRouteSource).toContain('to: "/settings/general"');
    expect(retiredBetaRouteSource).toContain("replace: true");
  });

  it("uses the V2 new-thread placement behavior without a feature flag", () => {
    expect(chatRouteSource).not.toContain("sidebarV2Enabled");
    expect(chatRouteSource).toContain("if (projectGroupCount > 1)");
    expect(chatRouteSource).toContain('openCommandPalette({ open: "new-thread-in" })');
  });
});
