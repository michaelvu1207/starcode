import {
  FleetOnboardingGateway,
  FleetOnboardingOperationError,
  FleetOnboardingPlatform,
  type FleetOnboardingHost,
  type FleetOnboardingJoinedNode,
  type FleetOnboardingProvisionedHost,
  type FleetVerificationThread,
} from "@starcode/client-runtime/onboarding";
import {
  EnvironmentRegistry,
  EnvironmentSupervisor,
  type PreparedConnection,
} from "@starcode/client-runtime/connection";
import { createThread, startThreadTurn } from "@starcode/client-runtime/operations";
import { ShellSnapshotLoader } from "@starcode/client-runtime/state/shell";
import { ThreadSnapshotLoader } from "@starcode/client-runtime/state/threads";
import {
  MessageId,
  ThreadId,
  type DesktopBridge,
  type EnvironmentId,
  type FleetClientBootstrapResult,
  type ModelSelection,
  type OrchestrationShellSnapshot,
} from "@starcode/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { PrimaryEnvironmentHttpClient } from "../environments/primary/httpClient";
import { randomUUID } from "../lib/utils";
import { runPrimaryHttp } from "../lib/runtime";

interface PendingFleetCredential {
  readonly pairingToken: string;
  readonly baseUrl: string;
}

interface VerificationContext {
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  readonly title: string;
}

const pendingCredentials = new Map<EnvironmentId, PendingFleetCredential>();
const verificationContexts = new Map<ThreadId, VerificationContext>();

const operationError = (
  stage: ConstructorParameters<typeof FleetOnboardingOperationError>[0],
  category: ConstructorParameters<typeof FleetOnboardingOperationError>[1]["category"],
  summary: string,
  action: string,
) => new FleetOnboardingOperationError(stage, { category, summary, action });

function isIpv4Address(value: string): boolean {
  const octets = value.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/u.test(octet)) {
        return false;
      }
      const number = Number(octet);
      return number >= 0 && number <= 255;
    })
  );
}

export function __networkBaseUrl(host: FleetOnboardingHost, port: number): string {
  const hostname =
    host.addresses.find(isIpv4Address) ?? host.dnsName ?? host.addresses[0] ?? host.hostname;
  const bracketed =
    hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${bracketed}:${port}/`;
}

function fleetNodeName(hostname: string): string {
  const normalized = hostname
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .slice(0, 64);
  return normalized === "" ? "starcode-node" : normalized;
}

export function __hasCompletedAssistantVerification(
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly streaming: boolean;
    readonly text: string;
  }>,
  expectedAssistantText: string,
): boolean {
  return messages.some(
    (entry) =>
      entry.role === "assistant" &&
      !entry.streaming &&
      entry.text.trim().includes(expectedAssistantText),
  );
}

export function __rosterContainsExpectedEnvironments(
  registeredEnvironmentIds: ReadonlyArray<EnvironmentId>,
  priorEnvironmentIds: ReadonlyArray<EnvironmentId>,
  joinedEnvironmentId: EnvironmentId,
): boolean {
  const registered = new Set(registeredEnvironmentIds);
  return [joinedEnvironmentId, ...priorEnvironmentIds].every((environmentId) =>
    registered.has(environmentId),
  );
}

export const __reconcileJoinedFleetSnapshot = Effect.fn(
  "web.fleetOnboarding.reconcileJoinedSnapshot",
)(function* (input: {
  readonly registry: Pick<EnvironmentRegistry["Service"], "reconcileFleet">;
  readonly anchorEnvironmentId: EnvironmentId;
  readonly joinedEnvironmentId: EnvironmentId;
  readonly snapshot: FleetClientBootstrapResult;
}) {
  if (!input.snapshot.nodes.some((node) => node.environmentId === input.joinedEnvironmentId)) {
    return yield* Effect.fail(
      operationError(
        "join-fleet",
        "fleet-join-failed",
        "The new fleet node joined, but its client connection was not issued.",
        "Keep both machines online, reconcile the fleet, and retry onboarding.",
      ),
    );
  }
  yield* input.registry.reconcileFleet(input.anchorEnvironmentId, input.snapshot);
});

export function makeFleetOnboardingPlatform(
  resolveBridge: () => DesktopBridge | undefined,
): FleetOnboardingPlatform["Service"] {
  return FleetOnboardingPlatform.of({
    discoverHosts: Effect.tryPromise({
      try: async () => {
        const bridge = resolveBridge();
        if (bridge === undefined) {
          throw operationError(
            "discover-tailnet",
            "platform-unavailable",
            "Fleet onboarding is available in the StarCode desktop app.",
            "Open this flow in the desktop app and retry.",
          );
        }
        return bridge.discoverFleetHosts();
      },
      catch: (cause) =>
        cause instanceof FleetOnboardingOperationError
          ? cause
          : operationError(
              "discover-tailnet",
              "tailnet-unavailable",
              "StarCode could not inspect the local Tailscale network.",
              "Start Tailscale on this Mac and retry.",
            ),
    }),
    preflight: (host) =>
      Effect.tryPromise({
        try: async () => {
          const bridge = resolveBridge();
          if (bridge === undefined) {
            throw operationError(
              "ssh-preflight",
              "platform-unavailable",
              "SSH preflight is available in the StarCode desktop app.",
              "Open this flow in the desktop app and retry.",
            );
          }
          return bridge.preflightFleetHost(host);
        },
        catch: (cause) =>
          cause instanceof FleetOnboardingOperationError
            ? cause
            : operationError(
                "ssh-preflight",
                "ssh-unreachable",
                `StarCode could not run the SSH preflight for ${host.hostname}.`,
                "Confirm the machine is online and accepts SSH from this Mac, then retry.",
              ),
      }),
    ensureStarcode: (host, preflight) =>
      Effect.tryPromise({
        try: async () => {
          const bridge = resolveBridge();
          if (bridge === undefined) {
            throw operationError(
              "install-starcode",
              "platform-unavailable",
              "Remote installation is available in the StarCode desktop app.",
              "Open this flow in the desktop app and retry.",
            );
          }
          const bootstrap = await bridge.ensureSshEnvironment(host.sshTarget, {
            issuePairingToken: true,
            networkAccessible: true,
          });
          const pairingToken = bootstrap.pairingToken;
          if (pairingToken === null) {
            throw operationError(
              "join-fleet",
              "fleet-join-failed",
              "The new StarCode service did not issue a fleet pairing credential.",
              "Restart the remote StarCode service and retry.",
            );
          }
          const descriptor = await bridge.fetchSshEnvironmentDescriptor(bootstrap.httpBaseUrl);
          const remotePort = bootstrap.remotePort ?? preflight.port.number;
          pendingCredentials.set(descriptor.environmentId, {
            pairingToken,
            baseUrl: __networkBaseUrl(host, remotePort),
          });
          return {
            environmentId: descriptor.environmentId,
            label: descriptor.label,
            remotePort,
            installation: preflight.starcodeInstalled ? "reused" : "installed",
            service: preflight.starcodeServiceRunning ? "reused" : "started",
          } satisfies FleetOnboardingProvisionedHost;
        },
        catch: (cause) =>
          cause instanceof FleetOnboardingOperationError
            ? cause
            : operationError(
                "install-starcode",
                "provisioning-failed",
                `StarCode could not be installed or started on ${host.hostname}.`,
                "Review the SSH preflight, then retry the installation.",
              ),
      }),
  });
}

export const fleetOnboardingPlatformLayer = Layer.succeed(
  FleetOnboardingPlatform,
  makeFleetOnboardingPlatform(() => window.desktopBridge),
);

const waitForPreparedConnection = Effect.fn("web.fleetOnboarding.waitForPrepared")(function* () {
  const supervisor = yield* EnvironmentSupervisor;
  const current = yield* SubscriptionRef.get(supervisor.prepared);
  if (Option.isSome(current)) {
    return current.value;
  }
  const next = yield* SubscriptionRef.changes(supervisor.prepared).pipe(
    Stream.filter(Option.isSome),
    Stream.runHead,
  );
  return Option.getOrThrow(Option.flatten(next));
});

function waitForConnectedEnvironment(
  registry: EnvironmentRegistry["Service"],
  environmentId: EnvironmentId,
  attempts = 80,
): Effect.Effect<void, FleetOnboardingOperationError> {
  if (attempts <= 0) {
    return Effect.fail(
      operationError(
        "create-verification-thread",
        "verification-failed",
        "The new fleet node joined, but the client could not connect to it.",
        "Keep both machines online and retry verification.",
      ),
    );
  }
  return registry.state(environmentId).pipe(
    Effect.flatMap((state) =>
      state.phase === "connected"
        ? Effect.void
        : registry
            .retryNow(environmentId)
            .pipe(
              Effect.andThen(Effect.sleep("250 millis")),
              Effect.andThen(
                Effect.suspend(() =>
                  waitForConnectedEnvironment(registry, environmentId, attempts - 1),
                ),
              ),
            ),
    ),
    Effect.catchTag("EnvironmentNotRegisteredError", () =>
      Effect.sleep("250 millis").pipe(
        Effect.andThen(
          Effect.suspend(() => waitForConnectedEnvironment(registry, environmentId, attempts - 1)),
        ),
      ),
    ),
  );
}

function loadShell(
  prepared: PreparedConnection,
  loader: ShellSnapshotLoader["Service"],
  attempts = 20,
): Effect.Effect<OrchestrationShellSnapshot, FleetOnboardingOperationError> {
  return loader.load(prepared).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          attempts <= 0
            ? Effect.fail(
                operationError(
                  "create-verification-thread",
                  "verification-failed",
                  "The new node connected, but its project list could not be read.",
                  "Reconnect the node and retry verification.",
                ),
              )
            : Effect.sleep("250 millis").pipe(
                Effect.andThen(loadShell(prepared, loader, attempts - 1)),
              ),
        onSome: Effect.succeed,
      }),
    ),
  );
}

export const makeFleetOnboardingGateway = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const shellLoader = yield* ShellSnapshotLoader;
  const threadLoader = yield* ThreadSnapshotLoader;
  const crypto = yield* Crypto.Crypto;

  const join: FleetOnboardingGateway["Service"]["join"] = Effect.fn("web.fleetOnboarding.join")(
    function* (input) {
      const pending = pendingCredentials.get(input.provisioned.environmentId);
      if (pending === undefined) {
        return yield* Effect.fail(
          operationError(
            "join-fleet",
            "fleet-join-failed",
            "The short-lived fleet credential is no longer available.",
            "Run onboarding again to issue a fresh credential.",
          ),
        );
      }

      const bridge = window.desktopBridge;
      const reciprocalBaseUrl =
        bridge === undefined
          ? undefined
          : yield* Effect.tryPromise({
              try: () => bridge.getAdvertisedEndpoints(),
              catch: () =>
                operationError(
                  "join-fleet",
                  "fleet-join-failed",
                  "The current node's advertised fleet endpoint could not be read.",
                  "Keep both nodes online on the tailnet and retry.",
                ),
            }).pipe(
              Effect.orElseSucceed(() => [] as const),
              Effect.map(
                (endpoints) =>
                  endpoints.find(
                    (endpoint) =>
                      endpoint.status === "available" &&
                      endpoint.reachability !== "loopback" &&
                      endpoint.isDefault === true,
                  )?.httpBaseUrl ??
                  endpoints.find(
                    (endpoint) =>
                      endpoint.status === "available" && endpoint.reachability !== "loopback",
                  )?.httpBaseUrl,
              ),
            );
      const rosterBefore = yield* Effect.tryPromise({
        try: () =>
          runPrimaryHttp(
            PrimaryEnvironmentHttpClient.pipe(
              Effect.flatMap((client) => client.fleet.snapshot({ headers: {} })),
            ),
          ),
        catch: () =>
          operationError(
            "join-fleet",
            "fleet-join-failed",
            "The anchor fleet roster could not be read before registration.",
            "Keep the anchor online and retry.",
          ),
      }).pipe(Effect.option);
      const result = yield* Effect.tryPromise({
        try: () =>
          runPrimaryHttp(
            PrimaryEnvironmentHttpClient.pipe(
              Effect.flatMap((client) =>
                client.fleet.register({
                  headers: {},
                  payload: {
                    name: fleetNodeName(input.host.hostname),
                    baseUrl: pending.baseUrl,
                    credential: { pairingToken: pending.pairingToken },
                    ...(input.host.sshTarget.username === null
                      ? {}
                      : { sshUser: input.host.sshTarget.username }),
                    ...(reciprocalBaseUrl === undefined ? {} : { reciprocalBaseUrl }),
                  },
                }),
              ),
            ),
          ),
        catch: () =>
          operationError(
            "join-fleet",
            "fleet-join-failed",
            "The current StarCode node could not reach the fleet registration endpoint.",
            "Confirm both nodes are online on the tailnet, then retry.",
          ),
      });
      pendingCredentials.delete(input.provisioned.environmentId);
      if (result.node.environmentId !== input.provisioned.environmentId) {
        return yield* Effect.fail(
          operationError(
            "join-fleet",
            "fleet-join-failed",
            "The registered node identity did not match the machine that was provisioned.",
            "Remove the stale fleet entry and retry onboarding.",
          ),
        );
      }
      if (
        !__rosterContainsExpectedEnvironments(
          result.roster.members.map((member) => member.node.environmentId),
          Option.isSome(rosterBefore)
            ? rosterBefore.value.members.map((member) => member.node.environmentId)
            : [],
          input.provisioned.environmentId,
        )
      ) {
        return yield* Effect.fail(
          operationError(
            "join-fleet",
            "fleet-join-failed",
            "Fleet registration completed, but the anchor roster did not retain every known node.",
            "Keep the fleet online, reconcile its rosters, and retry onboarding.",
          ),
        );
      }
      const bootstrap = yield* Effect.tryPromise({
        try: () =>
          runPrimaryHttp(
            PrimaryEnvironmentHttpClient.pipe(
              Effect.flatMap((client) =>
                Effect.all({
                  descriptor: client.metadata.descriptor(),
                  snapshot: client.fleet.clientBootstrap({ headers: {}, payload: {} }),
                }),
              ),
            ),
          ),
        catch: () =>
          operationError(
            "join-fleet",
            "fleet-join-failed",
            "The new fleet node joined, but its client connection could not be refreshed.",
            "Keep both machines online, reconcile the fleet, and retry onboarding.",
          ),
      });
      yield* __reconcileJoinedFleetSnapshot({
        registry,
        anchorEnvironmentId: bootstrap.descriptor.environmentId,
        joinedEnvironmentId: result.node.environmentId,
        snapshot: bootstrap.snapshot,
      });
      return {
        environmentId: result.node.environmentId,
        nodeName: result.node.name,
        label: result.node.label,
      } satisfies FleetOnboardingJoinedNode;
    },
  );

  const createVerificationThread: FleetOnboardingGateway["Service"]["createVerificationThread"] =
    Effect.fn("web.fleetOnboarding.createThread")(function* (node) {
      yield* waitForConnectedEnvironment(registry, node.environmentId);
      return yield* registry
        .run(
          node.environmentId,
          Effect.gen(function* () {
            const prepared = yield* waitForPreparedConnection();
            const snapshot = yield* loadShell(prepared, shellLoader);
            const project = snapshot.projects.find(
              (candidate) => candidate.defaultModelSelection !== null,
            );
            if (project === undefined || project.defaultModelSelection === null) {
              return yield* Effect.fail(
                operationError(
                  "create-verification-thread",
                  "verification-failed",
                  "The new node has no project with a configured model.",
                  "Configure a default model for one project on the new node, then retry verification.",
                ),
              );
            }
            const threadId = ThreadId.make(randomUUID());
            const title = "Fleet onboarding verification";
            yield* createThread({
              threadId,
              projectId: project.id,
              title,
              modelSelection: project.defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
            });
            verificationContexts.set(threadId, {
              environmentId: node.environmentId,
              modelSelection: project.defaultModelSelection,
              title,
            });
            return { threadId } satisfies FleetVerificationThread;
          }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
        )
        .pipe(
          Effect.mapError((error) =>
            error instanceof FleetOnboardingOperationError
              ? error
              : operationError(
                  "create-verification-thread",
                  "verification-failed",
                  "StarCode could not create a verification thread on the new node.",
                  "Confirm the node is connected and its default model is available, then retry.",
                ),
          ),
        );
    });

  const sendVerificationMessage: FleetOnboardingGateway["Service"]["sendVerificationMessage"] =
    Effect.fn("web.fleetOnboarding.sendMessage")(function* (input) {
      const context = verificationContexts.get(input.thread.threadId);
      if (context === undefined) {
        return yield* Effect.fail(
          operationError(
            "send-verification-message",
            "verification-failed",
            "The verification thread context is no longer available.",
            "Restart onboarding verification.",
          ),
        );
      }
      yield* registry
        .run(
          context.environmentId,
          startThreadTurn({
            threadId: input.thread.threadId,
            message: {
              messageId: MessageId.make(randomUUID()),
              role: "user",
              text: input.message,
              attachments: [],
            },
            modelSelection: context.modelSelection,
            titleSeed: context.title,
            runtimeMode: "full-access",
            interactionMode: "default",
          }).pipe(Effect.provideService(Crypto.Crypto, crypto)),
        )
        .pipe(
          Effect.mapError(() =>
            operationError(
              "send-verification-message",
              "verification-failed",
              "The verification message could not be sent to the new node.",
              "Confirm the provider is available on the new node and retry.",
            ),
          ),
        );
    });

  function readMessage(
    thread: FleetVerificationThread,
    expectedAssistantText: string,
    attempts = 240,
  ): Effect.Effect<boolean, FleetOnboardingOperationError> {
    const context = verificationContexts.get(thread.threadId);
    if (context === undefined) {
      return Effect.succeed(false);
    }
    return registry
      .run(
        context.environmentId,
        Effect.gen(function* () {
          const prepared = yield* waitForPreparedConnection();
          const snapshot = yield* threadLoader.load(prepared, thread.threadId);
          return (
            Option.isSome(snapshot) &&
            __hasCompletedAssistantVerification(
              snapshot.value.thread.messages,
              expectedAssistantText,
            )
          );
        }),
      )
      .pipe(
        Effect.mapError(() =>
          operationError(
            "read-verification-message",
            "verification-failed",
            "The verification thread could not be read from the new node.",
            "Keep the node connected and retry verification.",
          ),
        ),
        Effect.flatMap((found) => {
          if (found || attempts <= 0) {
            if (found) {
              verificationContexts.delete(thread.threadId);
            }
            return Effect.succeed(found);
          }
          return Effect.sleep("250 millis").pipe(
            Effect.andThen(readMessage(thread, expectedAssistantText, attempts - 1)),
          );
        }),
      );
  }

  return FleetOnboardingGateway.of({
    join,
    createVerificationThread,
    sendVerificationMessage,
    readVerificationMessage: ({ thread, expectedAssistantText }) =>
      readMessage(thread, expectedAssistantText).pipe(
        Effect.mapError(() =>
          operationError(
            "read-verification-message",
            "verification-failed",
            "The verification thread could not be read from the new node.",
            "Keep the node connected and retry verification.",
          ),
        ),
      ),
  });
});

export const fleetOnboardingGatewayLayer = Layer.effect(
  FleetOnboardingGateway,
  makeFleetOnboardingGateway,
);

export function __resetFleetOnboardingForTests(): void {
  pendingCredentials.clear();
  verificationContexts.clear();
}
