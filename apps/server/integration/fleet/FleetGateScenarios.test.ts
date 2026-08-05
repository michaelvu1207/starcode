// @effect-diagnostics globalDate:off - deterministic in-memory test timestamp
import { describe, expect, it } from "vite-plus/test";

import {
  FLEET_ONBOARDING_STAGES,
  FleetGateAssertionError,
  runG1ThreadServiceGate,
  runG2FleetRosterGate,
  runG3ClientUnificationGate,
  runG4OnboardingGate,
  type FleetGateClient,
  type FleetGateDriver,
  type FleetGateRosterMember,
  type FleetGateThread,
  type FleetGateThreadDetail,
  type FleetGateThreadList,
  type FleetOnboardingDiagnosisCode,
} from "./FleetGateScenarios.ts";
import { FLEET_HARNESS_NODE_NAMES, type FleetHarnessNodeName } from "./ThreeNodeFleetHarness.ts";

interface VersionedMember extends FleetGateRosterMember {
  readonly revision: number;
}

interface StoredThread {
  readonly thread: FleetGateThread;
  readonly messages: Array<string>;
}

/**
 * Validates the gate choreography without pretending to validate production.
 * The real adapter uses the same interface against the three subprocesses.
 */
class InMemoryFleetGateDriver implements FleetGateDriver {
  readonly #online = new Map(FLEET_HARNESS_NODE_NAMES.map((node) => [node, true]));
  readonly #edges = new Map(
    FLEET_HARNESS_NODE_NAMES.map((node) => [node, new Set<FleetHarnessNodeName>()]),
  );
  readonly #rosters = new Map(
    FLEET_HARNESS_NODE_NAMES.map((node) => [
      node,
      new Map<FleetHarnessNodeName, VersionedMember>([
        [
          node,
          {
            environmentId: `environment-${node}`,
            name: node,
            state: "active",
            revision: 0,
          },
        ],
      ]),
    ]),
  );
  readonly #threads = new Map<string, StoredThread>();
  readonly #clientPlacement = new Map<string, FleetHarnessNodeName>();
  #revision = 0;
  #nextThread = 0;
  #nextClient = 0;

  readonly pair = async (
    requester: FleetHarnessNodeName,
    target: FleetHarnessNodeName,
  ): Promise<void> => {
    this.#edges.get(requester)!.add(target);
    this.#edges.get(target)!.add(requester);
    this.#put(requester, target, "active");
    this.#put(target, requester, "active");
    this.#propagate();
  };

  readonly remove = async (
    requester: FleetHarnessNodeName,
    target: FleetHarnessNodeName,
  ): Promise<void> => {
    this.#put(requester, target, "tombstone");
    this.#propagate();
  };

  readonly reconcile = async (_requester: FleetHarnessNodeName): Promise<void> => {
    this.#propagate();
  };

  readonly roster = async (requester: FleetHarnessNodeName) => ({
    selfEnvironmentId: `environment-${requester}`,
    members: [...this.#rosters.get(requester)!.values()].map(
      ({ revision: _revision, ...member }) => member,
    ),
  });

  readonly readFleetDocument = async (node: FleetHarnessNodeName): Promise<unknown> => ({
    environmentId: `environment-${node}`,
    members: [...this.#rosters.get(node)!.values()],
  });

  readonly setNodeOnline = async (node: FleetHarnessNodeName, online: boolean): Promise<void> => {
    this.#online.set(node, online);
  };

  readonly restartNode = async (_node: FleetHarnessNodeName): Promise<void> => undefined;

  readonly listThreads = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly node?: FleetHarnessNodeName;
  }): Promise<FleetGateThreadList> => {
    const roster = this.#rosters.get(input.caller)!;
    const candidates =
      input.node === undefined
        ? [...roster.values()].filter((member) => member.state === "active")
        : [roster.get(input.node)].filter(
            (member): member is VersionedMember =>
              member !== undefined && member.state === "active",
          );
    const failures = candidates
      .filter((member) => !this.#online.get(member.name))
      .map((member) => ({ node: member.name, reason: "offline" }));
    const onlineNodes = new Set(
      candidates.filter((member) => this.#online.get(member.name)).map((member) => member.name),
    );
    return {
      threads: [...this.#threads.values()]
        .map((entry) => entry.thread)
        .filter((thread) => onlineNodes.has(thread.node)),
      failures,
    };
  };

  readonly readThread = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly threadId: string;
  }): Promise<FleetGateThreadDetail> => {
    const entry = this.#reachableThread(input.caller, input.threadId);
    return { thread: entry.thread, messages: [...entry.messages] };
  };

  readonly sendMessage = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly threadId: string;
    readonly message: string;
  }): Promise<void> => {
    this.#reachableThread(input.caller, input.threadId).messages.push(input.message);
  };

  readonly createThread = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly node?: FleetHarnessNodeName;
    readonly title: string;
    readonly message: string;
  }): Promise<FleetGateThread> => {
    const node = input.node ?? input.caller;
    this.#assertReachable(input.caller, node);
    const threadId = `thread-${++this.#nextThread}`;
    const thread: FleetGateThread = {
      threadId,
      node,
      project: `project-${node}`,
      title: input.title,
      status: "idle",
      lastActivityAt: new Date(this.#nextThread * 1_000).toISOString(),
    };
    this.#threads.set(threadId, { thread, messages: [input.message] });
    return thread;
  };

  readonly connectClient = async (anchor: FleetHarnessNodeName): Promise<FleetGateClient> => {
    const clientId = `client-${++this.#nextClient}`;
    this.#clientPlacement.set(clientId, anchor);
    return { anchor, clientId };
  };

  readonly clientListThreads = async (client: FleetGateClient): Promise<FleetGateThreadList> =>
    await this.listThreads({ caller: client.anchor });

  readonly clientSendMessage = async (
    client: FleetGateClient,
    threadId: string,
    message: string,
  ): Promise<void> => {
    await this.sendMessage({ caller: client.anchor, threadId, message });
  };

  readonly setClientDefaultPlacement = async (
    client: FleetGateClient,
    node: FleetHarnessNodeName,
  ): Promise<void> => {
    this.#clientPlacement.set(client.clientId, node);
  };

  readonly clientCreateThread = async (
    client: FleetGateClient,
    title: string,
    message: string,
  ): Promise<FleetGateThread> => {
    const node = this.#clientPlacement.get(client.clientId);
    return await this.createThread({
      caller: client.anchor,
      ...(node === undefined ? {} : { node }),
      title,
      message,
    });
  };

  readonly diagnoseOnboarding = async (code: FleetOnboardingDiagnosisCode) => ({
    code,
    diagnosis: `Actionable diagnosis for ${code.replaceAll("_", " ")}.`,
  });

  readonly onboard = async (input: {
    readonly anchor: FleetHarnessNodeName;
    readonly target: FleetHarnessNodeName;
  }) => {
    await this.pair(input.anchor, input.target);
    return { pairingActs: 1, stages: FLEET_ONBOARDING_STAGES };
  };

  #put(
    owner: FleetHarnessNodeName,
    member: FleetHarnessNodeName,
    state: VersionedMember["state"],
  ): void {
    this.#rosters.get(owner)!.set(member, {
      environmentId: `environment-${member}`,
      name: member,
      state,
      revision: ++this.#revision,
    });
  }

  #propagate(): void {
    for (const component of this.#components()) {
      const newest = new Map<FleetHarnessNodeName, VersionedMember>();
      for (const node of component) {
        if (!this.#online.get(node)) continue;
        for (const member of this.#rosters.get(node)!.values()) {
          const previous = newest.get(member.name);
          if (previous === undefined || member.revision > previous.revision) {
            newest.set(member.name, member);
          }
        }
      }
      for (const node of component) {
        if (!this.#online.get(node)) continue;
        const roster = this.#rosters.get(node)!;
        for (const member of newest.values()) {
          // A node's own record cannot be tombstoned in its own roster.
          if (member.name === node && member.state === "tombstone") continue;
          const previous = roster.get(member.name);
          if (previous === undefined || member.revision > previous.revision) {
            roster.set(member.name, member);
          }
        }
      }
    }
  }

  #components(): ReadonlyArray<ReadonlyArray<FleetHarnessNodeName>> {
    const unseen = new Set(FLEET_HARNESS_NODE_NAMES);
    const output: Array<ReadonlyArray<FleetHarnessNodeName>> = [];
    while (unseen.size > 0) {
      const first = unseen.values().next().value!;
      const component: Array<FleetHarnessNodeName> = [];
      const queue = [first];
      unseen.delete(first);
      while (queue.length > 0) {
        const current = queue.shift()!;
        component.push(current);
        for (const adjacent of this.#edges.get(current)!) {
          if (!unseen.delete(adjacent)) continue;
          queue.push(adjacent);
        }
      }
      output.push(component);
    }
    return output;
  }

  #assertReachable(caller: FleetHarnessNodeName, target: FleetHarnessNodeName): void {
    const member = this.#rosters.get(caller)!.get(target);
    if (member?.state !== "active" || !this.#online.get(target)) {
      throw new Error(`${target} is unreachable from ${caller}`);
    }
  }

  #reachableThread(caller: FleetHarnessNodeName, threadId: string): StoredThread {
    const entry = this.#threads.get(threadId);
    if (entry === undefined) throw new Error(`Unknown thread ${threadId}`);
    this.#assertReachable(caller, entry.thread.node);
    return entry;
  }
}

describe("permanent fleet gate scenarios", () => {
  it("G1 exercises one thread API, aliases, degradation, and recovery", async () => {
    await expect(
      runG1ThreadServiceGate(new InMemoryFleetGateDriver(), {
        timeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      }),
    ).resolves.toEqual({ gate: "G1", assertions: 11 });
  });

  it("G2 exercises transitive pairing, tombstones, persistence, and schema removal", async () => {
    await expect(
      runG2FleetRosterGate(new InMemoryFleetGateDriver(), {
        timeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      }),
    ).resolves.toEqual({ gate: "G2", assertions: 7 });
  });

  it("G3 exercises one-anchor visibility and placement-only switching", async () => {
    await expect(runG3ClientUnificationGate(new InMemoryFleetGateDriver())).resolves.toEqual({
      gate: "G3",
      assertions: 4,
    });
  });

  it("G4 exercises structured diagnostics and one-act unattended onboarding", async () => {
    await expect(runG4OnboardingGate(new InMemoryFleetGateDriver())).resolves.toEqual({
      gate: "G4",
      assertions: 10,
    });
  });

  it("fails loudly when partial failure is silently dropped", async () => {
    const driver = new InMemoryFleetGateDriver();
    const healthyList = driver.listThreads;
    const brokenDriver = new Proxy(driver, {
      get(target, property, receiver) {
        if (property !== "listThreads") return Reflect.get(target, property, receiver);
        return async (input: Parameters<FleetGateDriver["listThreads"]>[0]) => {
          const result = await healthyList(input);
          return { ...result, failures: [] };
        };
      },
    });

    await expect(
      runG1ThreadServiceGate(brokenDriver, {
        timeoutMilliseconds: 100,
        pollIntervalMilliseconds: 1,
      }),
    ).rejects.toBeInstanceOf(FleetGateAssertionError);
  });
});
