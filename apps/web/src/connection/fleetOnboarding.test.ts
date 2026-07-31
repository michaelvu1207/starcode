import type { DesktopBridge, EnvironmentId } from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  FleetOnboardingHost,
  FleetOnboardingPreflight,
} from "@starcode/client-runtime/onboarding";
import {
  __hasCompletedAssistantVerification,
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
});
