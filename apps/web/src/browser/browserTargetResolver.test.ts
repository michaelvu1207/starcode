import { EnvironmentId } from "@starcode/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const readPreparedConnection = vi.fn();
const remoteConnection = (httpBaseUrl: string) => ({
  httpBaseUrl,
  target: { _tag: "SshConnectionTarget" },
});
const localConnection = (httpBaseUrl: string) => ({
  httpBaseUrl,
  target: { _tag: "PrimaryConnectionTarget" },
});

vi.mock("~/state/session", () => ({ readPreparedConnection }));

describe("browser target resolver", () => {
  beforeEach(() => readPreparedConnection.mockReset());

  it("maps environment ports onto a private network host", async () => {
    readPreparedConnection.mockReturnValue(remoteConnection("http://192.168.1.25:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/dashboard",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard",
      resolvedUrl: "http://localhost:5173/dashboard",
      resolutionKind: "client-bridge",
      environmentId: "environment-1",
      target: { kind: "environment-port", port: 5173, path: "/dashboard" },
    });
  });

  it("maps localhost URL navigation onto a remote Tailscale IPv4 host", async () => {
    readPreparedConnection.mockReturnValue(remoteConnection("http://100.65.180.100:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:5173/dashboard?mode=test#results",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:5173/dashboard?mode=test#results",
      resolvedUrl: "http://localhost:5173/dashboard?mode=test#results",
      resolutionKind: "client-bridge",
      environmentId: "environment-1",
      target: {
        kind: "environment-port",
        port: 5173,
        protocol: "http",
        path: "/dashboard?mode=test#results",
      },
    });
  });

  it("preserves URL credentials when mapping localhost onto a remote host", async () => {
    readPreparedConnection.mockReturnValue(remoteConnection("http://100.65.180.100:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://user:p%40ss@localhost:5173/dashboard",
      }).resolvedUrl,
    ).toBe("http://user:p%40ss@localhost:5173/dashboard");
  });

  it("maps credentialed localhost URLs onto private IPv6 hosts", async () => {
    readPreparedConnection.mockReturnValue(remoteConnection("http://[fd7a:115c:a1e0::53]:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://user:p%40ss@localhost:5173/dashboard?mode=test#results",
      }).resolvedUrl,
    ).toBe("http://user:p%40ss@localhost:5173/dashboard?mode=test#results");
  });

  it("maps schemeless localhost navigation onto a remote environment host", async () => {
    readPreparedConnection.mockReturnValue(remoteConnection("http://192.168.1.25:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "localhost:3000/app",
      }).resolvedUrl,
    ).toBe("localhost:3000/app");
  });

  it("keeps localhost navigation local for a local environment", async () => {
    readPreparedConnection.mockReturnValue(localConnection("http://127.0.0.1:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "localhost:3000/app",
      resolvedUrl: "localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("keeps localhost navigation local for the full IPv4 loopback range", async () => {
    readPreparedConnection.mockReturnValue(localConnection("http://127.0.0.2:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:3000/app",
      }),
    ).toEqual({
      requestedUrl: "http://localhost:3000/app",
      resolvedUrl: "http://localhost:3000/app",
      resolutionKind: "direct",
      environmentId: "environment-1",
    });
  });

  it("routes public relay hosts through the authenticated client bridge", async () => {
    readPreparedConnection.mockReturnValue(remoteConnection("https://relay.example.com"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }),
    ).toMatchObject({ resolutionKind: "client-bridge", resolvedUrl: "http://localhost:5173/" });
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "url",
        url: "http://localhost:5173",
      }),
    ).toMatchObject({ resolutionKind: "client-bridge" });
  });

  it("normalizes schemeless localhost server-picker values", async () => {
    readPreparedConnection.mockReturnValue(localConnection("http://localhost:3773"));
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173")).toBe(
      "http://localhost:5173/",
    );
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "0.0.0.0:3000/app"),
    ).toBe("http://localhost:3000/app");
  });

  it("preserves localhost server-picker values when the prepared base is 127.0.0.1", async () => {
    readPreparedConnection.mockReturnValue(localConnection("http://127.0.0.1:3773"));
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(
      resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "localhost:5173/app?x=1#top"),
    ).toBe("http://localhost:5173/app?x=1#top");
  });

  it("normalizes public URLs without treating them as environment ports", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "example.com/app")).toBe(
      "https://example.com/app",
    );
  });

  it("supports private IPv6 environment hosts", async () => {
    readPreparedConnection.mockReturnValue(remoteConnection("http://[fd7a:115c:a1e0::53]:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
        path: "/app?mode=test",
      }).resolvedUrl,
    ).toBe("http://localhost:5173/app?mode=test");
  });

  it("supports a local IPv6 environment host", async () => {
    readPreparedConnection.mockReturnValue(localConnection("http://[::1]:3773"));
    const { resolveBrowserNavigationTarget } = await import("./browserTargetResolver");
    expect(
      resolveBrowserNavigationTarget(EnvironmentId.make("environment-1"), {
        kind: "environment-port",
        port: 5173,
      }).resolvedUrl,
    ).toBe("http://[::1]:5173/");
  });

  it("leaves malformed input for the normal navigation error path", async () => {
    const { resolveDiscoveredServerUrl } = await import("./browserTargetResolver");
    expect(resolveDiscoveredServerUrl(EnvironmentId.make("environment-1"), "   ")).toBe("   ");
  });
});
