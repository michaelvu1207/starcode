import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@starcode/contracts";
import { isLoopbackHost, normalizePreviewUrl } from "@starcode/shared/preview";

import { readPreparedConnection } from "~/state/session";

const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

const parseIpv4Address = (host: string): readonly number[] | null => {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
};

const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
};

const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (isLocalLoopbackHost(normalized) || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4Address(normalized);
  if (parts) {
    return (
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
};

const readEnvironmentConnection = (environmentId: EnvironmentId) => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return connection;
};

const connectionRequiresClientBridge = (
  connection: ReturnType<typeof readEnvironmentConnection>,
): boolean => {
  if (connection.target) return connection.target._tag !== "PrimaryConnectionTarget";
  return !isLocalLoopbackHost(new URL(connection.httpBaseUrl).hostname);
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
  requiresBridge: boolean,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const logicalUrl = requestedUrl ?? `${protocol}://localhost:${target.port}${path}`;
  if (requiresBridge) {
    return {
      requestedUrl: logicalUrl,
      resolvedUrl: logicalUrl,
      resolutionKind: "client-bridge",
      environmentId,
      target,
    };
  }
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error("This environment port is not reachable from the local preview client.");
  }
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  const resolvedHost = normalizedEnvironmentHost.includes(":")
    ? `[${normalizedEnvironmentHost}]`
    : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: logicalUrl,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedEnvironmentHost)
      ? "direct"
      : "direct-private-network",
    environmentId,
    target,
  };
};

export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(normalizePreviewUrl(target.url));
    } catch {
      // Preserve the existing direct-navigation behavior so the preview host
      // reports malformed URL errors through its normal navigation path.
    }
    if (parsed && isLoopbackHost(parsed.hostname)) {
      const connection = readEnvironmentConnection(environmentId);
      const environmentUrl = new URL(connection.httpBaseUrl);
      const requiresBridge = connectionRequiresClientBridge(connection);
      if (
        requiresBridge ||
        parsed.hostname === "0.0.0.0" ||
        !isLocalLoopbackHost(environmentUrl.hostname)
      ) {
        return resolveEnvironmentPortTarget(
          environmentId,
          {
            kind: "environment-port",
            port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
            protocol: parsed.protocol === "https:" ? "https" : "http",
            path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
          },
          environmentUrl,
          requiresBridge,
          target.url,
          parsed,
        );
      }
    }
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  const connection = readEnvironmentConnection(environmentId);
  return resolveEnvironmentPortTarget(
    environmentId,
    target,
    new URL(connection.httpBaseUrl),
    connectionRequiresClientBridge(connection),
  );
}

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    return resolveBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: normalizedUrl,
    }).resolvedUrl;
  } catch {
    return rawUrl;
  }
}
