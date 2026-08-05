import type { DesktopAppBranding } from "@starcode/contracts";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
/**
 * Fork brand name. User-visible only — the npm package, service labels, bundle
 * ids, and URL schemes stay on the upstream identifier, because renaming those
 * churns infrastructure for no daily value.
 *
 * The desktop shell still wins when it injects a name, so a desktop build
 * carrying upstream branding is not silently relabelled by the web client.
 */
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "starcode";
export const APP_STAGE_LABEL = "Latest";
export const APP_DISPLAY_NAME = APP_BASE_NAME;
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
