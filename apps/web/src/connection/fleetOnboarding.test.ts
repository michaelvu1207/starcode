import type { DesktopBridge, EnvironmentId } from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  FleetOnboardingHost,
  FleetOnboardingPreflight,
} from "@starcode/client-runtime/onboarding";
import {
  __hasCompletedAssistantVerification,
  __networkBaseUrl,
  __reconcileJoinedFleetSnapshot,
  __resetFleetOnboardingForTests,
  __rosterContainsExpectedEnvironments,
  makeFleetOnboardingPlatform,
} from "./fleetOnboarding";

const host: FleetOnboardingHost = {
  hostname: "build-mac",
  dnsName: "build-mac.example.ts.net",
  addresses: ["100.64.0.23"],
  online: true,
  sshTarget: {
    alias: "build-mac",
    hostname: "build-mac.example.ts.net",
    username: "builder",
    port: null,
  },
};

const preflight: FleetOnboardingPreflight = {
  readyForProvisioning: true,
  platform: "darwin",
  starcodeInstalled: true,
  starcodeServiceRunning: true,
  port: { number: 3773, status: "occupied", owner: "starcode" },
  diagnostics: [],
};

describe("web fleet onboarding platform", () => {
  it("prefers the peer's reachable Tailscale IPv4 address over MagicDNS", () => {
    expect(__networkBaseUrl(host, 3773)).toBe("http://100.64.0.23:3773/");
    expect(
      __networkBaseUrl(
        {
          ...host,
          addresses: ["fd7a:115c:a1e0::23"],
          dnsName: null,
        },
        3773,
      ),
    ).toBe("http://[fd7a:115c:a1e0::23]:3773/");
  });

  it.effect(
    "uses desktop discovery, preflight, and provisioning without returning credentials",
    () =>
      Effect.gen(function* () {
        __resetFleetOnboardingForTests();
        const calls: string[] = [];
        const bridge = {
          discoverFleetHosts: async () => {
            calls.push("discover");
            return {
              tailnetName: "example.ts.net",
              backendState: "Running",
              hosts: [host],
            };
          },
          preflightFleetHost: async () => {
            calls.push("preflight");
            return preflight;
          },
          ensureSshEnvironment: async () => {
            calls.push("ensure");
            return {
              target: host.sshTarget,
              httpBaseUrl: "http://127.0.0.1:49152/",
              wsBaseUrl: "ws://127.0.0.1:49152/",
              pairingToken: "one-time-secret",
              remotePort: 3773,
              remoteServerKind: "managed" as const,
            };
          },
          fetchSshEnvironmentDescriptor: async () => {
            calls.push("descriptor");
            return {
              environmentId: "environment-build-mac" as EnvironmentId,
              label: "Build Mac",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "test",
              capabilities: {},
            };
          },
        } as unknown as DesktopBridge;
        const platform = makeFleetOnboardingPlatform(() => bridge);

        const discovered = yield* platform.discoverHosts;
        const checked = yield* platform.preflight(host);
        const provisioned = yield* platform.ensureStarcode(host, checked);

        expect(discovered.hosts).toHaveLength(1);
        expect(provisioned).toMatchObject({
          environmentId: "environment-build-mac",
          installation: "reused",
          service: "reused",
        });
        expect(Object.values(provisioned).join(" ")).not.toContain("one-time-secret");
        expect(calls).toEqual(["discover", "preflight", "ensure", "descriptor"]);
      }),
  );

  it.effect("returns a safe diagnosis when desktop discovery throws sensitive detail", () =>
    Effect.gen(function* () {
      const platform = makeFleetOnboardingPlatform(
        () =>
          ({
            discoverFleetHosts: async () => {
              throw new Error("ssh secret path /private/key");
            },
          }) as unknown as DesktopBridge,
      );

      const error = yield* platform.discoverHosts.pipe(Effect.flip);
      expect(error.diagnosis).toMatchObject({
        category: "tailnet-unavailable",
        action: expect.stringContaining("Tailscale"),
      });
      expect(Object.values(error.diagnosis).join(" ")).not.toContain("/private/key");
    }),
  );

  it("requires completed assistant output instead of accepting the echoed user prompt", () => {
    const expected = "provider-ready-marker";
    expect(
      __hasCompletedAssistantVerification(
        [
          { role: "user", streaming: false, text: `Reply with ${expected}` },
          { role: "assistant", streaming: true, text: expected },
        ],
        expected,
      ),
    ).toBe(false);
    expect(
      __hasCompletedAssistantVerification(
        [
          { role: "user", streaming: false, text: `Reply with ${expected}` },
          { role: "assistant", streaming: false, text: expected },
        ],
        expected,
      ),
    ).toBe(true);
  });

  it("requires the anchor register result to retain prior nodes and include the joined node", () => {
    const anchor = "environment-anchor" as EnvironmentId;
    const existing = "environment-existing" as EnvironmentId;
    const joined = "environment-joined" as EnvironmentId;

    expect(
      __rosterContainsExpectedEnvironments([anchor, existing, joined], [anchor, existing], joined),
    ).toBe(true);
    expect(__rosterContainsExpectedEnvironments([anchor, joined], [anchor, existing], joined)).toBe(
      false,
    );
  });

  it.effect("installs the post-registration client bootstrap snapshot immediately", () =>
    Effect.gen(function* () {
      const anchorEnvironmentId = "environment-anchor" as EnvironmentId;
      const joinedEnvironmentId = "environment-joined" as EnvironmentId;
      const calls: Array<{
        readonly anchorEnvironmentId: EnvironmentId;
        readonly nodeIds: ReadonlyArray<EnvironmentId>;
      }> = [];
      const snapshot = {
        revision: 2,
        nodes: [
          {
            nodeId: "node-joined",
            environmentId: joinedEnvironmentId,
            label: "Joined",
            endpoint: {
              httpBaseUrl: "https://joined.example.test/",
              wsBaseUrl: "wss://joined.example.test/",
            },
            credential: { bearerToken: "attenuated-client-token" },
          },
        ],
      } as const;

      yield* __reconcileJoinedFleetSnapshot({
        registry: {
          reconcileFleet: (environmentId, next) =>
            Effect.sync(() => {
              calls.push({
                anchorEnvironmentId: environmentId,
                nodeIds: next.nodes.map((node) => node.environmentId),
              });
            }),
        },
        anchorEnvironmentId,
        joinedEnvironmentId,
        snapshot,
      });

      expect(calls).toEqual([
        {
          anchorEnvironmentId,
          nodeIds: [joinedEnvironmentId],
        },
      ]);
    }),
  );

  it.effect("rejects a stale bootstrap snapshot that omits the newly joined node", () =>
    Effect.gen(function* () {
      const error = yield* __reconcileJoinedFleetSnapshot({
        registry: {
          reconcileFleet: () => Effect.void,
        },
        anchorEnvironmentId: "environment-anchor" as EnvironmentId,
        joinedEnvironmentId: "environment-joined" as EnvironmentId,
        snapshot: { revision: 1, nodes: [] },
      }).pipe(Effect.flip);

      expect(error.diagnosis.summary).toContain("client connection was not issued");
    }),
  );
});
