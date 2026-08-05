import type { DesktopSshEnvironmentTarget, EnvironmentId, ThreadId } from "@starcode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type FleetOnboardingStage =
  | "discover-tailnet"
  | "resolve-host"
  | "ssh-preflight"
  | "install-starcode"
  | "start-starcode"
  | "join-fleet"
  | "create-verification-thread"
  | "send-verification-message"
  | "read-verification-message";

export type FleetOnboardingDiagnosisCategory =
  | "platform-unavailable"
  | "tailnet-unavailable"
  | "host-not-found"
  | "host-offline"
  | "ssh-unreachable"
  | "ssh-key-missing"
  | "unsupported-host"
  | "runtime-missing"
  | "port-occupied"
  | "provisioning-failed"
  | "fleet-join-failed"
  | "verification-failed";

export interface FleetOnboardingDiagnosis {
  readonly category: FleetOnboardingDiagnosisCategory;
  readonly summary: string;
  readonly action: string;
}

export class FleetOnboardingOperationError extends Error {
  readonly _tag = "FleetOnboardingOperationError";
  readonly stage: FleetOnboardingStage;
  readonly diagnosis: FleetOnboardingDiagnosis;

  constructor(stage: FleetOnboardingStage, diagnosis: FleetOnboardingDiagnosis) {
    super(diagnosis.summary);
    this.name = "FleetOnboardingOperationError";
    this.stage = stage;
    this.diagnosis = diagnosis;
  }
}

export interface FleetOnboardingHost {
  readonly hostname: string;
  readonly dnsName: string | null;
  readonly addresses: ReadonlyArray<string>;
  readonly online: boolean;
  readonly sshTarget: DesktopSshEnvironmentTarget;
}

export interface FleetHostDiscovery {
  readonly tailnetName: string | null;
  readonly backendState: string | null;
  readonly hosts: ReadonlyArray<FleetOnboardingHost>;
}

export type FleetPreflightDiagnosticCategory =
  | "ssh-client-unavailable"
  | "host-unreachable"
  | "ssh-connection-failed"
  | "host-key-rejected"
  | "authentication-failed"
  | "remote-shell-unsupported"
  | "probe-output-invalid"
  | "unsupported-os"
  | "node-missing"
  | "node-version-unknown"
  | "node-version-unsupported"
  | "package-manager-missing"
  | "starcode-not-installed"
  | "starcode-service-not-installed"
  | "starcode-service-stopped"
  | "port-occupied"
  | "port-status-unknown"
  | "tailscale-missing"
  | "tailscale-not-running";

export interface FleetPreflightDiagnostic {
  readonly category: FleetPreflightDiagnosticCategory;
  readonly severity: "info" | "warning" | "error";
  readonly summary: string;
  readonly action: string;
}

export interface FleetOnboardingPreflight {
  readonly readyForProvisioning: boolean;
  readonly platform: "linux" | "darwin" | "windows" | "unknown";
  readonly starcodeInstalled: boolean;
  readonly starcodeServiceRunning: boolean;
  readonly port: {
    readonly number: number;
    readonly status: "available" | "occupied" | "unknown";
    readonly owner: string | null;
  };
  readonly diagnostics: ReadonlyArray<FleetPreflightDiagnostic>;
}

export interface FleetOnboardingProvisionedHost {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly remotePort: number;
  readonly installation: "installed" | "reused";
  readonly service: "started" | "reused";
}

export interface FleetOnboardingJoinedNode {
  readonly environmentId: EnvironmentId;
  readonly nodeName: string;
  readonly label: string;
}

export interface FleetVerificationThread {
  readonly threadId: ThreadId;
}

export class FleetOnboardingPlatform extends Context.Service<
  FleetOnboardingPlatform,
  {
    readonly discoverHosts: Effect.Effect<FleetHostDiscovery, FleetOnboardingOperationError>;
    readonly preflight: (
      host: FleetOnboardingHost,
    ) => Effect.Effect<FleetOnboardingPreflight, FleetOnboardingOperationError>;
    readonly ensureStarcode: (
      host: FleetOnboardingHost,
      preflight: FleetOnboardingPreflight,
    ) => Effect.Effect<FleetOnboardingProvisionedHost, FleetOnboardingOperationError>;
  }
>()("@starcode/client-runtime/onboarding/agent/FleetOnboardingPlatform") {}

export class FleetOnboardingGateway extends Context.Service<
  FleetOnboardingGateway,
  {
    /**
     * This is the workflow's only fleet membership mutation. Implementations
     * must not issue a second register call during verification.
     */
    readonly join: (input: {
      readonly host: FleetOnboardingHost;
      readonly provisioned: FleetOnboardingProvisionedHost;
    }) => Effect.Effect<FleetOnboardingJoinedNode, FleetOnboardingOperationError>;
    readonly createVerificationThread: (
      node: FleetOnboardingJoinedNode,
    ) => Effect.Effect<FleetVerificationThread, FleetOnboardingOperationError>;
    readonly sendVerificationMessage: (input: {
      readonly thread: FleetVerificationThread;
      readonly message: string;
    }) => Effect.Effect<void, FleetOnboardingOperationError>;
    readonly readVerificationMessage: (input: {
      readonly thread: FleetVerificationThread;
      readonly expectedAssistantText: string;
    }) => Effect.Effect<boolean, FleetOnboardingOperationError>;
  }
>()("@starcode/client-runtime/onboarding/agent/FleetOnboardingGateway") {}

export interface FleetOnboardingStepResult {
  readonly stage: FleetOnboardingStage;
  readonly status: "completed" | "reused";
  readonly summary: string;
}

export interface FleetOnboardingSuccess {
  readonly status: "joined";
  readonly node: FleetOnboardingJoinedNode;
  readonly verificationThreadId: ThreadId;
  readonly steps: ReadonlyArray<FleetOnboardingStepResult>;
  readonly diagnostics: ReadonlyArray<FleetPreflightDiagnostic>;
}

export interface FleetOnboardingDiagnosed {
  readonly status: "diagnosed";
  readonly failedStage: FleetOnboardingStage;
  readonly diagnosis: FleetOnboardingDiagnosis;
  readonly steps: ReadonlyArray<FleetOnboardingStepResult>;
}

export type FleetOnboardingResult = FleetOnboardingSuccess | FleetOnboardingDiagnosed;

const normalizedHostKey = (value: string): string =>
  value.trim().replace(/\.$/u, "").toLocaleLowerCase();

export function findDiscoveredHost(
  discovery: FleetHostDiscovery,
  requestedHostname: string,
): FleetOnboardingHost | null {
  const requested = normalizedHostKey(requestedHostname);
  if (requested === "") {
    return null;
  }
  return (
    discovery.hosts.find((host) => {
      const candidates = [
        host.hostname,
        host.dnsName,
        host.sshTarget.alias,
        host.sshTarget.hostname,
        ...host.addresses,
      ];
      return candidates.some(
        (candidate) => candidate !== null && normalizedHostKey(candidate) === requested,
      );
    }) ?? null
  );
}

const RECOVERABLE_RUNTIME_DIAGNOSTICS = new Set<FleetPreflightDiagnosticCategory>([
  "node-missing",
  "node-version-unsupported",
  "package-manager-missing",
]);

function preflightDiagnosis(report: FleetOnboardingPreflight): FleetOnboardingDiagnosis | null {
  const error = report.diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === "error" && !RECOVERABLE_RUNTIME_DIAGNOSTICS.has(diagnostic.category),
  );
  if (error === undefined) {
    const runtimeError = report.diagnostics.find(
      (diagnostic) =>
        diagnostic.severity === "error" && RECOVERABLE_RUNTIME_DIAGNOSTICS.has(diagnostic.category),
    );
    if (runtimeError !== undefined && report.platform !== "linux" && report.platform !== "darwin") {
      return {
        category: "unsupported-host",
        summary: `Automatic Node.js bootstrap is not supported on ${report.platform}.`,
        action: "Install a supported Node.js runtime on the target, then retry onboarding.",
      };
    }
    return null;
  }

  switch (error.category) {
    case "authentication-failed":
    case "host-key-rejected":
      return {
        category: "ssh-key-missing",
        summary: "SSH could reach the machine, but it could not authenticate.",
        action: "Install or authorize this Mac's SSH key on the target, then retry.",
      };
    case "ssh-client-unavailable":
    case "host-unreachable":
    case "ssh-connection-failed":
      return {
        category: "ssh-unreachable",
        summary: error.summary,
        action: error.action,
      };
    case "port-occupied":
      return {
        category: "port-occupied",
        summary: error.summary,
        action: error.action,
      };
    case "node-missing":
    case "node-version-unsupported":
    case "package-manager-missing":
      return {
        category: "runtime-missing",
        summary: error.summary,
        action: error.action,
      };
    case "tailscale-missing":
    case "tailscale-not-running":
      return {
        category: "tailnet-unavailable",
        summary: error.summary,
        action: error.action,
      };
    case "remote-shell-unsupported":
    case "unsupported-os":
      return {
        category: "unsupported-host",
        summary: error.summary,
        action: error.action,
      };
    case "probe-output-invalid":
    case "node-version-unknown":
    case "port-status-unknown":
    case "starcode-not-installed":
    case "starcode-service-not-installed":
    case "starcode-service-stopped":
      return {
        category: "provisioning-failed",
        summary: error.summary,
        action: error.action,
      };
  }
}

const asDiagnosed = (
  error: FleetOnboardingOperationError,
  steps: ReadonlyArray<FleetOnboardingStepResult>,
): FleetOnboardingDiagnosed => ({
  status: "diagnosed",
  failedStage: error.stage,
  diagnosis: error.diagnosis,
  steps,
});

const step = (
  stage: FleetOnboardingStage,
  summary: string,
  status: FleetOnboardingStepResult["status"] = "completed",
): FleetOnboardingStepResult => ({ stage, status, summary });

export const runFleetOnboarding = Effect.fn("FleetOnboardingAgent.run")(function* (input: {
  readonly hostname: string;
  readonly verificationMessage?: string;
}): Effect.fn.Return<
  FleetOnboardingResult,
  never,
  FleetOnboardingPlatform | FleetOnboardingGateway
> {
  const platform = yield* FleetOnboardingPlatform;
  const gateway = yield* FleetOnboardingGateway;
  const steps: FleetOnboardingStepResult[] = [];

  const discoveryResult = yield* platform.discoverHosts.pipe(Effect.result);
  if (discoveryResult._tag === "Failure") {
    return asDiagnosed(discoveryResult.failure, steps);
  }
  const discovery = discoveryResult.success;
  steps.push(
    step(
      "discover-tailnet",
      discovery.tailnetName === null
        ? "Checked the local network for reachable machines."
        : `Detected tailnet ${discovery.tailnetName}.`,
    ),
  );

  const host = findDiscoveredHost(discovery, input.hostname);
  if (host === null) {
    return {
      status: "diagnosed",
      failedStage: "resolve-host",
      diagnosis: {
        category: "host-not-found",
        summary: `No tailnet or SSH host matched “${input.hostname.trim()}”.`,
        action: "Check the hostname in Tailscale or SSH configuration, then retry.",
      },
      steps,
    };
  }
  if (!host.online) {
    return {
      status: "diagnosed",
      failedStage: "resolve-host",
      diagnosis: {
        category: "host-offline",
        summary: `${host.hostname} is known but currently offline.`,
        action: "Wake the machine and confirm Tailscale is connected, then retry.",
      },
      steps,
    };
  }
  steps.push(step("resolve-host", `Resolved ${host.hostname} on the tailnet.`));

  const preflightResult = yield* platform.preflight(host).pipe(Effect.result);
  if (preflightResult._tag === "Failure") {
    return asDiagnosed(preflightResult.failure, steps);
  }
  const preflight = preflightResult.success;
  const diagnosis = preflightDiagnosis(preflight);
  const errorDiagnostics = preflight.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  const hasOnlyRecoverableRuntimeErrors =
    errorDiagnostics.length > 0 &&
    errorDiagnostics.every((diagnostic) =>
      RECOVERABLE_RUNTIME_DIAGNOSTICS.has(diagnostic.category),
    );
  if ((!preflight.readyForProvisioning && !hasOnlyRecoverableRuntimeErrors) || diagnosis !== null) {
    return {
      status: "diagnosed",
      failedStage: "ssh-preflight",
      diagnosis:
        diagnosis ??
        ({
          category: "provisioning-failed",
          summary: "The machine did not pass the StarCode preflight.",
          action: "Review the preflight findings and retry.",
        } satisfies FleetOnboardingDiagnosis),
      steps,
    };
  }
  steps.push(
    step(
      "ssh-preflight",
      hasOnlyRecoverableRuntimeErrors
        ? "SSH is ready; StarCode will install its supported Node.js runtime."
        : "SSH and remote prerequisites are ready.",
    ),
  );

  const provisionedResult = yield* platform.ensureStarcode(host, preflight).pipe(Effect.result);
  if (provisionedResult._tag === "Failure") {
    return asDiagnosed(provisionedResult.failure, steps);
  }
  const provisioned = provisionedResult.success;
  steps.push(
    step(
      "install-starcode",
      provisioned.installation === "reused"
        ? "Reused the existing StarCode installation."
        : "Installed StarCode.",
      provisioned.installation === "reused" ? "reused" : "completed",
    ),
    step(
      "start-starcode",
      provisioned.service === "reused"
        ? "Reused the running StarCode service."
        : "Started the StarCode service.",
      provisioned.service === "reused" ? "reused" : "completed",
    ),
  );

  const joinResult = yield* gateway.join({ host, provisioned }).pipe(Effect.result);
  if (joinResult._tag === "Failure") {
    return asDiagnosed(joinResult.failure, steps);
  }
  const node = joinResult.success;
  steps.push(step("join-fleet", `${node.label} joined the fleet.`));

  const createResult = yield* gateway.createVerificationThread(node).pipe(Effect.result);
  if (createResult._tag === "Failure") {
    return asDiagnosed(createResult.failure, steps);
  }
  const thread = createResult.success;
  steps.push(step("create-verification-thread", "Created a verification thread on the new node."));

  const expectedAssistantText = input.verificationMessage?.trim() || "STARCODE_FLEET_READY";
  const verificationMessage = `Reply with exactly “${expectedAssistantText}” to confirm this provider is running. Do not use tools.`;
  const sendResult = yield* gateway
    .sendVerificationMessage({ thread, message: verificationMessage })
    .pipe(Effect.result);
  if (sendResult._tag === "Failure") {
    return asDiagnosed(sendResult.failure, steps);
  }
  steps.push(step("send-verification-message", "Sent the verification message."));

  const readResult = yield* gateway
    .readVerificationMessage({ thread, expectedAssistantText })
    .pipe(Effect.result);
  if (readResult._tag === "Failure") {
    return asDiagnosed(readResult.failure, steps);
  }
  if (!readResult.success) {
    return {
      status: "diagnosed",
      failedStage: "read-verification-message",
      diagnosis: {
        category: "verification-failed",
        summary: "The verification thread ran, but no completed assistant response was readable.",
        action: "Confirm the provider is configured on the new node, then retry verification.",
      },
      steps,
    };
  }
  steps.push(step("read-verification-message", "Received and read a completed provider response."));

  return {
    status: "joined",
    node,
    verificationThreadId: thread.threadId,
    steps,
    diagnostics: preflight.diagnostics,
  };
});
