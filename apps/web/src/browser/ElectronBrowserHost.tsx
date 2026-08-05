"use client";

import { parseScopedThreadKey } from "@starcode/client-runtime/environment";
import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@starcode/contracts";
import { useEffect, useMemo, useState } from "react";

import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import { useActivePreviewSessions } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { readPreparedConnection } from "~/state/session";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { resolveBrowserNavigationTarget } from "./browserTargetResolver";

function ResolvedHostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly snapshot: PreviewSessionSnapshot;
  readonly zoomFactor: number;
}) {
  const { threadRef, snapshot, zoomFactor } = props;
  const createTicket = useAtomCommand(
    previewEnvironment.createPortBridgeTicket,
    "preview port bridge ticket",
  );
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, "preview status report");
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null);
  const targetKey = JSON.stringify(snapshot.target ?? null);

  useEffect(() => {
    const navUrl = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
    if (!snapshot.target || snapshot.target.kind === "url") {
      setResolvedUrl(navUrl);
      return;
    }

    const target = snapshot.target;
    const resolution = resolveBrowserNavigationTarget(threadRef.environmentId, target);
    if (resolution.resolutionKind !== "client-bridge") {
      setResolvedUrl(resolution.resolvedUrl);
      return;
    }

    const preview = window.desktopBridge?.preview;
    const connection = readPreparedConnection(threadRef.environmentId);
    if (!preview || !connection) {
      setResolvedUrl(null);
      return;
    }

    let disposed = false;
    let bridgeId: string | null = null;
    setResolvedUrl(null);
    void (async () => {
      const ticket = await createTicket({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, port: target.port },
      });
      if (ticket._tag === "Failure") throw ticket.cause;
      if (disposed) return;
      const bridge = await preview.openPortBridge({
        environmentId: threadRef.environmentId,
        httpBaseUrl: connection.httpBaseUrl,
        ticket: ticket.value.ticket,
        remotePort: target.port,
        protocol: target.protocol ?? "http",
      });
      bridgeId = bridge.bridgeId;
      if (disposed) {
        await preview.closePortBridge(bridge.bridgeId).catch(() => undefined);
        return;
      }
      const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
      setResolvedUrl(new URL(path, `${bridge.baseUrl}/`).toString());
    })().catch((cause: unknown) => {
      if (disposed) return;
      setResolvedUrl(null);
      const logicalUrl = resolution.requestedUrl;
      void reportStatus({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId: snapshot.tabId,
          navStatus: {
            _tag: "LoadFailed",
            url: logicalUrl,
            title: logicalUrl,
            code: -111,
            description:
              cause instanceof Error ? cause.message : "Unable to connect to the dev server.",
          },
          canGoBack: false,
          canGoForward: false,
        },
      });
    });

    return () => {
      disposed = true;
      if (bridgeId) void preview.closePortBridge(bridgeId).catch(() => undefined);
    };
  }, [
    createTicket,
    reportStatus,
    snapshot.tabId,
    targetKey,
    threadRef.environmentId,
    threadRef.threadId,
  ]);

  if (resolvedUrl === null && snapshot.navStatus._tag !== "Idle") return null;
  return (
    <HostedBrowserWebview
      key={`${snapshot.tabId}:${resolvedUrl ?? "idle"}`}
      threadRef={threadRef}
      tabId={snapshot.tabId}
      initialUrl={resolvedUrl}
      viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
      zoomFactor={zoomFactor}
    />
  );
}

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.sessions).map((snapshot) => ({
              threadRef,
              snapshot,
              zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
            }))
          : [];
      }),
    [previewByThreadKey],
  );

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(({ threadRef, snapshot, zoomFactor }) => {
        return (
          <ResolvedHostedBrowserWebview
            key={snapshot.tabId}
            threadRef={threadRef}
            snapshot={snapshot}
            zoomFactor={zoomFactor}
          />
        );
      })}
    </div>
  );
}
