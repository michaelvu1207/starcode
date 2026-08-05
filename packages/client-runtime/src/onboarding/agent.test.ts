import { EnvironmentId, ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type FleetHostDiscovery,
  FleetOnboardingGateway,
  type FleetOnboardingGateway as FleetOnboardingGatewayService,
  type FleetOnboardingHost,
  FleetOnboardingPlatform,
  type FleetOnboardingPlatform as FleetOnboardingPlatformService,
  type FleetOnboardingPreflight,
  runFleetOnboarding,
} from "./agent.ts";

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

const discovery: FleetHostDiscovery = {
  tailnetName: "example.ts.net",
  backendState: "Running",
  hosts: [host],
};

const readyPreflight: FleetOnboardingPreflight = {
  readyForProvisioning: true,
  platform: "darwin",
  starcodeInstalled: false,
  starcodeServiceRunning: false,
  port: { number: 3773, status: "available", owner: null },
  diagnostics: [
    {
      category: "starcode-not-installed",
      severity: "info",
      summary: "StarCode is not installed.",
      action: "Install StarCode.",
    },
  ],
};

function layers(options?: {
  readonly discovery?: FleetHostDiscovery;
  readonly preflight?: FleetOnboardingPreflight;
  readonly installation?: "installed" | "reused";
  readonly service?: "started" | "reused";
  readonly onPreflight?: () => void;
  readonly onJoin?: () => void;
  readonly readBack?: boolean;
  readonly onRead?: (expectedAssistantText: string) => void;
}) {
  const platform = FleetOnboardingPlatform.of({
    discoverHosts: Effect.succeed(options?.discovery ?? discovery),
    preflight: () => {
      options?.onPreflight?.();
      return Effect.succeed(options?.preflight ?? readyPreflight);
    },
    ensureStarcode: () =>
      Effect.succeed({
        environmentId: EnvironmentId.make("environment-build-mac"),
        label: "Build Mac",
        remotePort: 3773,
        installation: options?.installation ?? "installed",
        service: options?.service ?? "started",
      }),
  }) satisfies FleetOnboardingPlatformService["Service"];
  const gateway = FleetOnboardingGateway.of({
    join: () => {
      options?.onJoin?.();
      return Effect.succeed({
        environmentId: EnvironmentId.make("environment-build-mac"),
        nodeName: "build-mac",
        label: "Build Mac",
      });
    },
    createVerificationThread: () =>
      Effect.succeed({ threadId: ThreadId.make("verification-thread") }),
    sendVerificationMessage: () => Effect.void,
    readVerificationMessage: ({ expectedAssistantText }) => {
      options?.onRead?.(expectedAssistantText);
      return Effect.succeed(options?.readBack ?? true);
    },
  }) satisfies FleetOnboardingGatewayService["Service"];
  return Layer.merge(
    Layer.succeed(FleetOnboardingPlatform, platform),
    Layer.succeed(FleetOnboardingGateway, gateway),
  );
}

describe("fleet onboarding agent", () => {
  it.effect("joins once and verifies the node from a hostname alone", () => {
    let joins = 0;
    return Effect.gen(function* () {
      const result = yield* runFleetOnboarding({
        hostname: "build-mac.example.ts.net.",
        verificationMessage: "round trip marker",
      }).pipe(Effect.provide(layers({ onJoin: () => joins++ })));

      expect(result.status).toBe("joined");
      expect(joins).toBe(1);
      if (result.status !== "joined") return;
      expect(result.node.environmentId).toBe("environment-build-mac");
      expect(result.verificationThreadId).toBe("verification-thread");
      expect(result.steps.map((entry) => entry.stage)).toEqual([
        "discover-tailnet",
        "resolve-host",
        "ssh-preflight",
        "install-starcode",
        "start-starcode",
        "join-fleet",
        "create-verification-thread",
        "send-verification-message",
        "read-verification-message",
      ]);
    });
  });

  it.effect("diagnoses a wrong hostname without attempting SSH or joining", () => {
    let preflights = 0;
    let joins = 0;
    return Effect.gen(function* () {
      const result = yield* runFleetOnboarding({ hostname: "missing-host" }).pipe(
        Effect.provide(
          layers({
            onPreflight: () => preflights++,
            onJoin: () => joins++,
          }),
        ),
      );

      expect(result).toMatchObject({
        status: "diagnosed",
        failedStage: "resolve-host",
        diagnosis: { category: "host-not-found" },
      });
      expect(preflights).toBe(0);
      expect(joins).toBe(0);
    });
  });

  it.effect("turns SSH authentication rejection into an actionable key diagnosis", () =>
    Effect.gen(function* () {
      const result = yield* runFleetOnboarding({ hostname: "100.64.0.23" }).pipe(
        Effect.provide(
          layers({
            preflight: {
              ...readyPreflight,
              readyForProvisioning: false,
              diagnostics: [
                {
                  category: "authentication-failed",
                  severity: "error",
                  summary: "SSH authentication failed.",
                  action: "Authorize a key.",
                },
              ],
            },
          }),
        ),
      );

      expect(result).toMatchObject({
        status: "diagnosed",
        failedStage: "ssh-preflight",
        diagnosis: {
          category: "ssh-key-missing",
          action: expect.stringContaining("SSH key"),
        },
      });
    }),
  );

  it.effect("reports an occupied non-StarCode port before provisioning", () =>
    Effect.gen(function* () {
      const result = yield* runFleetOnboarding({ hostname: "build-mac" }).pipe(
        Effect.provide(
          layers({
            preflight: {
              ...readyPreflight,
              readyForProvisioning: false,
              port: { number: 3773, status: "occupied", owner: "python" },
              diagnostics: [
                {
                  category: "port-occupied",
                  severity: "error",
                  summary: "Port 3773 is already occupied.",
                  action: "Stop the conflicting process.",
                },
              ],
            },
          }),
        ),
      );

      expect(result).toMatchObject({
        status: "diagnosed",
        failedStage: "ssh-preflight",
        diagnosis: { category: "port-occupied" },
      });
    }),
  );

  it.effect(
    "reuses an existing installation and running service without treating them as errors",
    () =>
      Effect.gen(function* () {
        const result = yield* runFleetOnboarding({ hostname: "build-mac" }).pipe(
          Effect.provide(
            layers({
              installation: "reused",
              service: "reused",
              preflight: {
                ...readyPreflight,
                starcodeInstalled: true,
                starcodeServiceRunning: true,
                port: { number: 3773, status: "occupied", owner: "starcode" },
                diagnostics: [],
              },
            }),
          ),
        );

        expect(result.status).toBe("joined");
        if (result.status !== "joined") return;
        expect(
          result.steps
            .filter(
              (entry) => entry.stage === "install-starcode" || entry.stage === "start-starcode",
            )
            .map((entry) => entry.status),
        ).toEqual(["reused", "reused"]);
      }),
  );

  it.effect("diagnoses a failed message read after create and send succeed", () =>
    Effect.gen(function* () {
      const result = yield* runFleetOnboarding({ hostname: "build-mac" }).pipe(
        Effect.provide(layers({ readBack: false })),
      );

      expect(result).toMatchObject({
        status: "diagnosed",
        failedStage: "read-verification-message",
        diagnosis: { category: "verification-failed" },
      });
    }),
  );

  it.effect("allows a clean supported host to bootstrap a missing runtime", () =>
    Effect.gen(function* () {
      const result = yield* runFleetOnboarding({ hostname: "build-mac" }).pipe(
        Effect.provide(
          layers({
            preflight: {
              ...readyPreflight,
              readyForProvisioning: false,
              diagnostics: [
                {
                  category: "node-missing",
                  severity: "error",
                  summary: "Node.js is missing.",
                  action: "Install Node.js.",
                },
                {
                  category: "package-manager-missing",
                  severity: "error",
                  summary: "No package manager is available.",
                  action: "Install npm.",
                },
              ],
            },
          }),
        ),
      );

      expect(result.status).toBe("joined");
      if (result.status !== "joined") return;
      expect(result.steps.find((entry) => entry.stage === "ssh-preflight")?.summary).toContain(
        "install",
      );
    }),
  );

  it.effect("requires a completed provider response rather than the sent prompt", () => {
    let expected = "";
    return Effect.gen(function* () {
      const result = yield* runFleetOnboarding({
        hostname: "build-mac",
        verificationMessage: "provider-ready-marker",
      }).pipe(
        Effect.provide(
          layers({
            onRead: (value) => {
              expected = value;
            },
          }),
        ),
      );

      expect(result.status).toBe("joined");
      expect(expected).toBe("provider-ready-marker");
    });
  });

  it.effect("keeps automatic runtime bootstrap unsupported cases actionable", () =>
    Effect.gen(function* () {
      const result = yield* runFleetOnboarding({ hostname: "build-mac" }).pipe(
        Effect.provide(
          layers({
            preflight: {
              ...readyPreflight,
              platform: "windows",
              readyForProvisioning: false,
              diagnostics: [
                {
                  category: "node-missing",
                  severity: "error",
                  summary: "Node.js is missing.",
                  action: "Install Node.js.",
                },
              ],
            },
          }),
        ),
      );

      expect(result).toMatchObject({
        status: "diagnosed",
        failedStage: "ssh-preflight",
        diagnosis: { category: "unsupported-host", action: expect.stringContaining("Node.js") },
      });
    }),
  );
});
