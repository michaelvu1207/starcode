// @effect-diagnostics globalDate:off globalTimers:off - deterministic Promise-based black-box gate polling
import type { FleetHarnessNodeName } from "./ThreeNodeFleetHarness.ts";

export type FleetGateBinding = "canonical" | "deprecated-peer-alias";

export interface FleetGateRosterMember {
  readonly environmentId: string;
  readonly name: FleetHarnessNodeName;
  readonly state: "active" | "tombstone";
}

export interface FleetGateRosterSnapshot {
  readonly selfEnvironmentId: string;
  readonly members: ReadonlyArray<FleetGateRosterMember>;
}

export interface FleetGateThread {
  readonly threadId: string;
  readonly node: FleetHarnessNodeName;
  readonly project: string;
  readonly title: string;
  readonly status: string;
  readonly lastActivityAt: string;
}

export interface FleetGateThreadFailure {
  readonly node: FleetHarnessNodeName;
  readonly reason: string;
}

export interface FleetGateThreadList {
  readonly threads: ReadonlyArray<FleetGateThread>;
  readonly failures: ReadonlyArray<FleetGateThreadFailure>;
}

export interface FleetGateThreadDetail {
  readonly thread: FleetGateThread;
  readonly messages: ReadonlyArray<string>;
}

export interface FleetGateClient {
  readonly anchor: FleetHarnessNodeName;
  readonly clientId: string;
}

export const FLEET_ONBOARDING_STAGES = [
  "tailnet-detect",
  "ssh-connect",
  "install",
  "start",
  "fleet-pair",
  "verify",
] as const;

export type FleetOnboardingStage = (typeof FLEET_ONBOARDING_STAGES)[number];

export type FleetOnboardingDiagnosisCode =
  | "host_unreachable"
  | "ssh_auth_failed"
  | "port_occupied"
  | "already_present";

export interface FleetGateDriver {
  /**
   * Registers target from requester. Phase 2 is responsible for making the
   * resulting membership symmetric and transitive.
   */
  readonly pair: (requester: FleetHarnessNodeName, target: FleetHarnessNodeName) => Promise<void>;
  readonly remove: (requester: FleetHarnessNodeName, target: FleetHarnessNodeName) => Promise<void>;
  readonly reconcile: (requester: FleetHarnessNodeName) => Promise<void>;
  readonly roster: (requester: FleetHarnessNodeName) => Promise<FleetGateRosterSnapshot>;
  readonly readFleetDocument: (node: FleetHarnessNodeName) => Promise<unknown>;
  readonly setNodeOnline: (node: FleetHarnessNodeName, online: boolean) => Promise<void>;
  readonly restartNode: (node: FleetHarnessNodeName) => Promise<void>;

  /**
   * Mirrors ThreadService. Only create accepts a node placement hint; read and
   * send intentionally route by threadId alone.
   */
  readonly listThreads: (input: {
    readonly caller: FleetHarnessNodeName;
    readonly node?: FleetHarnessNodeName;
    readonly binding?: FleetGateBinding;
  }) => Promise<FleetGateThreadList>;
  readonly readThread: (input: {
    readonly caller: FleetHarnessNodeName;
    readonly threadId: string;
    readonly binding?: FleetGateBinding;
  }) => Promise<FleetGateThreadDetail>;
  readonly sendMessage: (input: {
    readonly caller: FleetHarnessNodeName;
    readonly threadId: string;
    readonly message: string;
    readonly binding?: FleetGateBinding;
  }) => Promise<void>;
  readonly createThread: (input: {
    readonly caller: FleetHarnessNodeName;
    readonly node?: FleetHarnessNodeName;
    readonly title: string;
    readonly message: string;
    readonly binding?: FleetGateBinding;
  }) => Promise<FleetGateThread>;

  /**
   * Phase 3 hooks model a client that knows one anchor only. Implementations may
   * proxy through the anchor or derive short-lived connections to fleet nodes.
   */
  readonly connectClient: (anchor: FleetHarnessNodeName) => Promise<FleetGateClient>;
  readonly clientListThreads: (client: FleetGateClient) => Promise<FleetGateThreadList>;
  readonly clientSendMessage: (
    client: FleetGateClient,
    threadId: string,
    message: string,
  ) => Promise<void>;
  readonly setClientDefaultPlacement: (
    client: FleetGateClient,
    node: FleetHarnessNodeName,
  ) => Promise<void>;
  readonly clientCreateThread: (
    client: FleetGateClient,
    title: string,
    message: string,
  ) => Promise<FleetGateThread>;

  /**
   * Phase 4 uses gamma as a genuinely fresh target in the disposable rig.
   * Real-fleet G4 supplies a separate clean box through the same adapter.
   */
  readonly diagnoseOnboarding: (
    code: FleetOnboardingDiagnosisCode,
  ) => Promise<{ readonly code: FleetOnboardingDiagnosisCode; readonly diagnosis: string }>;
  readonly onboard: (input: {
    readonly anchor: FleetHarnessNodeName;
    readonly target: FleetHarnessNodeName;
  }) => Promise<{
    readonly pairingActs: number;
    readonly stages: ReadonlyArray<FleetOnboardingStage>;
  }>;
}

export interface FleetGateTiming {
  readonly timeoutMilliseconds?: number;
  readonly pollIntervalMilliseconds?: number;
}

export interface FleetGateResult {
  readonly gate: "G1" | "G2" | "G3" | "G4";
  readonly assertions: number;
}

export class FleetGateAssertionError extends Error {
  readonly gate: FleetGateResult["gate"];

  constructor(gate: FleetGateResult["gate"], message: string) {
    super(`${gate}: ${message}`);
    this.name = "FleetGateAssertionError";
    this.gate = gate;
  }
}

const defaultTiming = {
  timeoutMilliseconds: 5_000,
  pollIntervalMilliseconds: 25,
} as const;

const eventually = async (
  gate: FleetGateResult["gate"],
  description: string,
  check: () => Promise<boolean>,
  timing: FleetGateTiming,
): Promise<void> => {
  const timeoutMilliseconds = timing.timeoutMilliseconds ?? defaultTiming.timeoutMilliseconds;
  const pollIntervalMilliseconds =
    timing.pollIntervalMilliseconds ?? defaultTiming.pollIntervalMilliseconds;
  const deadline = Date.now() + timeoutMilliseconds;
  let lastCause: unknown;

  while (Date.now() <= deadline) {
    try {
      if (await check()) return;
    } catch (cause) {
      lastCause = cause;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollIntervalMilliseconds);
    });
  }

  const suffix = lastCause instanceof Error ? ` Last error: ${lastCause.message}` : "";
  throw new FleetGateAssertionError(gate, `${description}.${suffix}`);
};

const assertGate = (gate: FleetGateResult["gate"], condition: boolean, message: string): void => {
  if (!condition) throw new FleetGateAssertionError(gate, message);
};

const threadNodes = (result: FleetGateThreadList): Set<FleetHarnessNodeName> =>
  new Set(result.threads.map((thread) => thread.node));

const threadIds = (result: FleetGateThreadList): ReadonlyArray<string> =>
  result.threads.map((thread) => thread.threadId).toSorted();

const includesMessage = (detail: FleetGateThreadDetail, message: string): boolean =>
  detail.messages.some((entry) => entry.includes(message));

const withTimeout = async <A>(
  gate: FleetGateResult["gate"],
  description: string,
  effect: Promise<A>,
  timeoutMilliseconds: number,
): Promise<A> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      effect,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new FleetGateAssertionError(gate, description)),
          timeoutMilliseconds,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const hasKeyRecursively = (value: unknown, target: string): boolean => {
  if (Array.isArray(value)) return value.some((entry) => hasKeyRecursively(entry, target));
  if (value === null || typeof value !== "object") return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    Object.hasOwn(record, target) ||
    Object.values(record).some((entry) => hasKeyRecursively(entry, target))
  );
};

const manuallyPairAllNodes = async (driver: FleetGateDriver): Promise<void> => {
  await driver.pair("alpha", "beta");
  await driver.pair("alpha", "gamma");
  await driver.pair("beta", "gamma");
  await Promise.all([
    driver.reconcile("alpha"),
    driver.reconcile("beta"),
    driver.reconcile("gamma"),
  ]);
};

export const runG1ThreadServiceGate = async (
  driver: FleetGateDriver,
  timing: FleetGateTiming = {},
): Promise<FleetGateResult> => {
  const gate = "G1";
  let assertions = 0;
  await manuallyPairAllNodes(driver);

  const alphaThread = await driver.createThread({
    caller: "alpha",
    node: "alpha",
    title: "Alpha fixture",
    message: "alpha initial",
  });
  const betaThread = await driver.createThread({
    caller: "alpha",
    node: "beta",
    title: "Beta fixture",
    message: "beta initial",
  });
  const gammaThread = await driver.createThread({
    caller: "alpha",
    node: "gamma",
    title: "Gamma fixture",
    message: "gamma initial",
  });

  let listed = await driver.listThreads({ caller: "alpha" });
  await eventually(
    gate,
    "threads_list did not converge on local and remote threads",
    async () => {
      listed = await driver.listThreads({ caller: "alpha" });
      const nodes = threadNodes(listed);
      return ["alpha", "beta", "gamma"].every((node) => nodes.has(node as FleetHarnessNodeName));
    },
    timing,
  );
  const visibleNodes = threadNodes(listed);
  assertGate(
    gate,
    ["alpha", "beta", "gamma"].every((node) => visibleNodes.has(node as FleetHarnessNodeName)),
    "threads_list did not return local and remote threads in one result",
  );
  assertions++;

  const routedMessage = "canonical thread_send reached gamma";
  await driver.sendMessage({
    caller: "alpha",
    threadId: gammaThread.threadId,
    message: routedMessage,
  });
  let routedDetail = await driver.readThread({
    caller: "alpha",
    threadId: gammaThread.threadId,
  });
  await eventually(
    gate,
    "thread_send result did not become readable on gamma",
    async () => {
      routedDetail = await driver.readThread({
        caller: "alpha",
        threadId: gammaThread.threadId,
      });
      return includesMessage(routedDetail, routedMessage);
    },
    timing,
  );
  assertGate(
    gate,
    includesMessage(routedDetail, routedMessage),
    "thread_send did not route by threadId to gamma",
  );
  assertions++;

  const created = await driver.createThread({
    caller: "alpha",
    node: "gamma",
    title: "Remote canonical create",
    message: "remote initial turn",
  });
  await eventually(
    gate,
    "remote thread_create did not enter the fleet index",
    async () =>
      (await driver.listThreads({ caller: "alpha" })).threads.some(
        (thread) => thread.threadId === created.threadId,
      ),
    timing,
  );
  const createdDetail = await driver.readThread({
    caller: "alpha",
    threadId: created.threadId,
  });
  assertGate(
    gate,
    includesMessage(createdDetail, "remote initial turn"),
    "remote thread_create did not start its initial turn",
  );
  assertions += 2;

  const aliasList = await driver.listThreads({
    caller: "alpha",
    binding: "deprecated-peer-alias",
  });
  assertGate(
    gate,
    aliasList.threads.some((thread) => thread.threadId === betaThread.threadId),
    "peer_threads_list alias no longer reaches remote threads",
  );
  const aliasDetail = await driver.readThread({
    caller: "alpha",
    threadId: betaThread.threadId,
    binding: "deprecated-peer-alias",
  });
  assertGate(
    gate,
    aliasDetail.thread.threadId === betaThread.threadId,
    "peer_thread_read alias no longer reads remote threads",
  );
  const aliasMessage = "deprecated alias reached beta";
  await driver.sendMessage({
    caller: "alpha",
    threadId: betaThread.threadId,
    message: aliasMessage,
    binding: "deprecated-peer-alias",
  });
  let aliasRouted = false;
  await eventually(
    gate,
    "peer_thread_send alias result did not become readable on beta",
    async () => {
      aliasRouted = includesMessage(
        await driver.readThread({ caller: "alpha", threadId: betaThread.threadId }),
        aliasMessage,
      );
      return aliasRouted;
    },
    timing,
  );
  assertGate(gate, aliasRouted, "peer_thread_send alias no longer routes to remote threads");
  const aliasCreated = await driver.createThread({
    caller: "alpha",
    node: "beta",
    title: "Deprecated alias create",
    message: "alias initial",
    binding: "deprecated-peer-alias",
  });
  assertGate(
    gate,
    aliasCreated.node === "beta",
    "peer_thread_create alias no longer honors remote placement",
  );
  assertions += 4;

  await driver.setNodeOnline("gamma", false);
  const degraded = await withTimeout(
    gate,
    "threads_list hung on an offline node",
    driver.listThreads({ caller: "alpha" }),
    timing.timeoutMilliseconds ?? defaultTiming.timeoutMilliseconds,
  );
  const survivingNodes = threadNodes(degraded);
  assertGate(
    gate,
    survivingNodes.has("alpha") &&
      survivingNodes.has("beta") &&
      degraded.failures.some((failure) => failure.node === "gamma"),
    "threads_list did not return surviving nodes plus a gamma failure",
  );
  assertions++;

  await driver.setNodeOnline("gamma", true);
  await eventually(
    gate,
    "gamma did not recover into threads_list",
    async () => threadNodes(await driver.listThreads({ caller: "alpha" })).has("gamma"),
    timing,
  );
  assertions++;

  assertGate(
    gate,
    alphaThread.node === "alpha",
    "the caller's own thread was not represented with the uniform thread shape",
  );
  assertions++;
  return { gate, assertions };
};

export const runG2FleetRosterGate = async (
  driver: FleetGateDriver,
  timing: FleetGateTiming = {},
): Promise<FleetGateResult> => {
  const gate = "G2";
  let assertions = 0;

  await driver.pair("alpha", "beta");
  await driver.pair("beta", "gamma");
  await Promise.all([
    driver.reconcile("alpha"),
    driver.reconcile("beta"),
    driver.reconcile("gamma"),
  ]);

  await eventually(
    gate,
    "alpha did not learn gamma transitively after only alpha-beta and beta-gamma pairing",
    async () =>
      (await driver.roster("alpha")).members.some(
        (member) => member.name === "gamma" && member.state === "active",
      ),
    timing,
  );
  assertions++;

  await driver.remove("alpha", "gamma");
  await driver.reconcile("beta");
  await driver.reconcile("alpha");
  const removedRoster = await driver.roster("alpha");
  assertGate(
    gate,
    removedRoster.members.some((member) => member.name === "gamma" && member.state === "tombstone"),
    "gamma removal did not leave a tombstone on alpha",
  );
  assertions++;

  await driver.reconcile("beta");
  await driver.reconcile("alpha");
  const reconciledRoster = await driver.roster("alpha");
  assertGate(
    gate,
    reconciledRoster.members.some(
      (member) => member.name === "gamma" && member.state === "tombstone",
    ),
    "beta's stale active record resurrected gamma over alpha's tombstone",
  );
  assertions++;

  for (const node of ["alpha", "beta", "gamma"] as const) {
    const document = await driver.readFleetDocument(node);
    assertGate(
      gate,
      !hasKeyRecursively(document, "credentialClass"),
      `${node}'s fleet.json still contains credentialClass`,
    );
    assertions++;
  }

  await driver.restartNode("alpha");
  await driver.reconcile("alpha");
  const restartedRoster = await driver.roster("alpha");
  assertGate(
    gate,
    restartedRoster.members.some(
      (member) => member.name === "gamma" && member.state === "tombstone",
    ),
    "alpha lost its tombstone across restart",
  );
  assertions++;

  return { gate, assertions };
};

export const runG3ClientUnificationGate = async (
  driver: FleetGateDriver,
  timing: FleetGateTiming = {},
): Promise<FleetGateResult> => {
  const gate = "G3";
  let assertions = 0;
  await driver.pair("alpha", "beta");
  await driver.pair("beta", "gamma");
  await Promise.all([
    driver.reconcile("alpha"),
    driver.reconcile("beta"),
    driver.reconcile("gamma"),
  ]);

  await driver.createThread({
    caller: "alpha",
    node: "alpha",
    title: "Client alpha",
    message: "alpha",
  });
  await driver.createThread({
    caller: "alpha",
    node: "beta",
    title: "Client beta",
    message: "beta",
  });
  const gammaThread = await driver.createThread({
    caller: "alpha",
    node: "gamma",
    title: "Client gamma",
    message: "gamma",
  });

  const client = await driver.connectClient("alpha");
  const beforePlacementChange = await driver.clientListThreads(client);
  const nodes = threadNodes(beforePlacementChange);
  assertGate(
    gate,
    ["alpha", "beta", "gamma"].every((node) => nodes.has(node as FleetHarnessNodeName)),
    "a client paired only to alpha did not see all fleet threads",
  );
  assertions++;

  const clientMessage = "alpha-paired client reached gamma";
  await driver.clientSendMessage(client, gammaThread.threadId, clientMessage);
  let clientMessageReachedGamma = false;
  await eventually(
    gate,
    "the alpha-paired client's message did not become readable on gamma",
    async () => {
      clientMessageReachedGamma = includesMessage(
        await driver.readThread({ caller: "alpha", threadId: gammaThread.threadId }),
        clientMessage,
      );
      return clientMessageReachedGamma;
    },
    timing,
  );
  assertGate(
    gate,
    clientMessageReachedGamma,
    "an alpha-paired client could not message a gamma thread",
  );
  assertions++;

  await driver.setClientDefaultPlacement(client, "beta");
  const afterPlacementChange = await driver.clientListThreads(client);
  assertGate(
    gate,
    JSON.stringify(threadIds(beforePlacementChange)) ===
      JSON.stringify(threadIds(afterPlacementChange)),
    "changing default placement changed which threads the client could see",
  );
  const placed = await driver.clientCreateThread(client, "Default placement", "created on beta");
  assertGate(gate, placed.node === "beta", "default placement did not affect new work");
  assertions += 2;

  return { gate, assertions };
};

export const runG4OnboardingGate = async (driver: FleetGateDriver): Promise<FleetGateResult> => {
  const gate = "G4";
  let assertions = 0;
  await driver.pair("alpha", "beta");
  await Promise.all([driver.reconcile("alpha"), driver.reconcile("beta")]);

  for (const code of [
    "host_unreachable",
    "ssh_auth_failed",
    "port_occupied",
    "already_present",
  ] as const) {
    const result = await driver.diagnoseOnboarding(code);
    assertGate(
      gate,
      result.code === code && result.diagnosis.trim().length > 0,
      `onboarding did not provide an actionable ${code} diagnosis`,
    );
    assertions++;
  }

  const result = await driver.onboard({ anchor: "alpha", target: "gamma" });
  assertGate(gate, result.pairingActs === 1, "onboarding required more than one pairing act");
  assertGate(
    gate,
    FLEET_ONBOARDING_STAGES.every((stage) => result.stages.includes(stage)),
    "onboarding did not complete every required stage",
  );
  assertions += 2;

  for (const node of ["alpha", "beta", "gamma"] as const) {
    const roster = await driver.roster(node);
    assertGate(
      gate,
      ["alpha", "beta", "gamma"].every((expected) =>
        roster.members.some((member) => member.name === expected && member.state === "active"),
      ),
      `${node} did not learn the complete roster after onboarding`,
    );
    assertions++;
  }

  const thread = await driver.createThread({
    caller: "alpha",
    node: "gamma",
    title: "Onboarding verification",
    message: "created after onboarding",
  });
  const message = "messaged after onboarding";
  await driver.sendMessage({ caller: "alpha", threadId: thread.threadId, message });
  assertGate(
    gate,
    includesMessage(
      await driver.readThread({ caller: "alpha", threadId: thread.threadId }),
      message,
    ),
    "the onboarded node could not create and receive thread work",
  );
  assertions++;

  return { gate, assertions };
};
