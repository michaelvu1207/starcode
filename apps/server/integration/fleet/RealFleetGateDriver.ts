// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off - real HTTP, MCP, filesystem, and subprocess integration boundary
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  FLEET_ONBOARDING_STAGES,
  type FleetGateBinding,
  type FleetGateClient,
  type FleetGateDriver,
  type FleetGateRosterSnapshot,
  type FleetGateThread,
  type FleetGateThreadDetail,
  type FleetGateThreadList,
  type FleetOnboardingDiagnosisCode,
} from "./FleetGateScenarios.ts";
import {
  FLEET_HARNESS_NODE_NAMES,
  makeSourceServerNodeLauncher,
  ThreeNodeFleetHarness,
  waitForEnvironmentDescriptor,
  type FleetHarnessNodeName,
} from "./ThreeNodeFleetHarness.ts";

interface EnvironmentDescriptor {
  readonly environmentId: string;
  readonly label: string;
}

interface FleetRosterWire {
  readonly revision: number;
  readonly members: ReadonlyArray<{
    readonly node: {
      readonly environmentId: string;
      readonly name: string;
      readonly label: string;
    };
  }>;
  readonly tombstones: ReadonlyArray<{
    readonly environmentId: string;
  }>;
}

interface FleetClientBootstrapWire {
  readonly revision: number;
  readonly nodes: ReadonlyArray<{
    readonly nodeId: string;
    readonly environmentId: string;
    readonly label: string;
    readonly endpoint: {
      readonly httpBaseUrl: string;
      readonly wsBaseUrl: string;
    };
    readonly credential: {
      readonly bearerToken: string;
      readonly expiresAtEpochMs?: number;
    };
  }>;
}

interface ThreadSummaryWire {
  readonly node: string;
  readonly local: boolean;
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly lastActivityAt: string;
  readonly project?: string | null;
}

interface ThreadsListWire {
  readonly threads: ReadonlyArray<ThreadSummaryWire>;
  readonly failures: ReadonlyArray<{ readonly node: string; readonly reason: string }>;
}

interface PeerThreadsListWire {
  readonly threads: ReadonlyArray<
    Omit<ThreadSummaryWire, "node" | "local"> & { readonly peer: string }
  >;
  readonly failures: ReadonlyArray<{ readonly peer: string; readonly reason: string }>;
}

interface ThreadReadWire {
  readonly node: string;
  readonly local: boolean;
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly entries: ReadonlyArray<{ readonly text: string }>;
}

interface PeerThreadReadWire {
  readonly peer: string;
  readonly threadId: string;
  readonly title: string;
  readonly status: string;
  readonly entries: ReadonlyArray<{ readonly text: string }>;
}

interface OrchestrationShellWire {
  readonly projects: ReadonlyArray<{
    readonly id: string;
  }>;
  readonly threads: ReadonlyArray<{
    readonly id: string;
    readonly projectId: string;
    readonly title: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly archivedAt: string | null;
    readonly latestTurn: null | {
      readonly state: "running" | "completed" | "error" | "interrupted";
    };
    readonly hasPendingApprovals: boolean;
    readonly hasPendingUserInput: boolean;
  }>;
}

interface CapturedMcpCredential {
  readonly endpoint: string;
  readonly token: string;
}

interface ClientConnectionState {
  readonly client: FleetGateClient;
  readonly nodes: ReadonlyMap<
    FleetHarnessNodeName,
    {
      readonly baseUrl: string;
      readonly bearerToken: string;
    }
  >;
  placement: FleetHarnessNodeName;
}

const ADMINISTRATIVE_SCOPE =
  "orchestration:read orchestration:operate terminal:operate review:write relay:read access:read access:write relay:write";
const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const REQUEST_TIMEOUT_MS = 15_000;
const MODEL_SELECTION = { instanceId: "codex", model: "gpt-5-codex" } as const;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const eventually = async (
  description: string,
  check: () => Promise<boolean>,
  timeoutMilliseconds = 20_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      if (await check()) return;
    } catch (cause) {
      lastError = cause;
    }
    await wait(50);
  }
  const suffix = lastError instanceof Error ? ` Last error: ${lastError.message}` : "";
  throw new Error(`${description}.${suffix}`);
};

const requestJson = async <A>(input: {
  readonly baseUrl: string;
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: string;
  readonly body?: unknown;
  readonly form?: URLSearchParams;
}): Promise<A> => {
  const method = input.method ?? "GET";
  let response: Response;
  try {
    response = await fetch(new URL(input.path, input.baseUrl), {
      method,
      headers: {
        ...(input.bearerToken === undefined
          ? {}
          : { authorization: `Bearer ${input.bearerToken}` }),
        ...(input.form === undefined
          ? input.body === undefined
            ? {}
            : { "content-type": "application/json" }
          : { "content-type": "application/x-www-form-urlencoded" }),
      },
      body:
        input.form !== undefined
          ? input.form.toString()
          : input.body === undefined
            ? undefined
            : JSON.stringify(input.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error(`${method} ${input.path} did not complete.`);
  }
  if (!response.ok) {
    // Fleet bootstrap and OAuth responses contain credentials. Never include a
    // response body in an integration failure.
    throw new Error(`${method} ${input.path} returned HTTP ${response.status}.`);
  }
  return (await response.json()) as A;
};

class McpCredentialCaptureBroker {
  readonly socketPath: string;
  readonly #server: NodeNet.Server;
  readonly #captured = new Map<string, Array<string>>();
  readonly #waiters = new Map<string, Array<(token: string) => void>>();

  private constructor(socketPath: string, server: NodeNet.Server) {
    this.socketPath = socketPath;
    this.#server = server;
  }

  static async start(rootDir: string): Promise<McpCredentialCaptureBroker> {
    const socketPath = NodePath.join(rootDir, "mcp-capture.sock");
    await NodeFSP.rm(socketPath, { force: true });
    const server = NodeNet.createServer();
    const broker = new McpCredentialCaptureBroker(socketPath, server);
    server.on("connection", (socket) => broker.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await NodeFSP.chmod(socketPath, 0o600);
    return broker;
  }

  async take(endpoint: string, timeoutMilliseconds = 20_000): Promise<string> {
    const available = this.#captured.get(endpoint);
    const token = available?.shift();
    if (token !== undefined) return token;

    return await new Promise<string>((resolve, reject) => {
      const waiters = this.#waiters.get(endpoint) ?? [];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const onToken = (captured: string) => {
        if (timeout !== undefined) clearTimeout(timeout);
        resolve(captured);
      };
      waiters.push(onToken);
      this.#waiters.set(endpoint, waiters);
      timeout = setTimeout(() => {
        const current = this.#waiters.get(endpoint) ?? [];
        this.#waiters.set(
          endpoint,
          current.filter((waiter) => waiter !== onToken),
        );
        reject(new Error("Timed out waiting for the provider-scoped MCP credential."));
      }, timeoutMilliseconds);
    });
  }

  async close(): Promise<void> {
    this.#captured.clear();
    this.#waiters.clear();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    await NodeFSP.rm(this.socketPath, { force: true });
  }

  #accept(socket: NodeNet.Socket): void {
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", (chunk: string) => {
      input += chunk;
    });
    socket.on("end", () => {
      for (const line of input.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let captured: CapturedMcpCredential;
        try {
          captured = JSON.parse(trimmed) as CapturedMcpCredential;
        } catch {
          continue;
        }
        if (
          typeof captured.endpoint !== "string" ||
          typeof captured.token !== "string" ||
          captured.token.length === 0
        ) {
          continue;
        }
        const waiter = this.#waiters.get(captured.endpoint)?.shift();
        if (waiter !== undefined) {
          waiter(captured.token);
          continue;
        }
        const available = this.#captured.get(captured.endpoint) ?? [];
        available.push(captured.token);
        this.#captured.set(captured.endpoint, available);
      }
    });
    socket.on("error", () => undefined);
  }
}

class RealMcpClient {
  readonly #endpoint: string;
  readonly #token: string;
  #sessionId: string | undefined;
  #nextId = 0;

  constructor(endpoint: string, token: string) {
    this.#endpoint = endpoint;
    this.#token = token;
  }

  async initialize(): Promise<void> {
    const response = await this.#post({
      jsonrpc: "2.0",
      id: ++this.#nextId,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "starcode-fleet-gate", version: "1.0.0" },
      },
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId === null || sessionId.length === 0) {
      throw new Error("MCP initialize did not return a session id.");
    }
    this.#sessionId = sessionId;
    await response.json();
  }

  async callTool<A>(name: string, args: unknown): Promise<A> {
    if (this.#sessionId === undefined) await this.initialize();
    const response = await this.#post({
      jsonrpc: "2.0",
      id: ++this.#nextId,
      method: "tools/call",
      params: { name, arguments: args },
    });
    const body = (await response.json()) as {
      readonly error?: unknown;
      readonly result?: {
        readonly content?: ReadonlyArray<{ readonly text?: string }>;
        readonly isError?: boolean;
        readonly structuredContent?: unknown;
      };
    };
    if (body.error !== undefined || body.result?.isError === true) {
      const rawDetail =
        body.result?.content?.find((entry) => typeof entry.text === "string")?.text ??
        (typeof body.error === "object" && body.error !== null && "message" in body.error
          ? String(body.error.message)
          : "No diagnostic was returned.");
      const safeDetail = rawDetail
        .replace(/Bearer\s+\S+/giu, "Bearer <redacted>")
        .replace(/(token|credential|secret)=\S+/giu, "$1=<redacted>")
        .slice(0, 1_000);
      throw new Error(`MCP tool ${name} failed: ${safeDetail}`);
    }
    return body.result?.structuredContent as A;
  }

  async listTools(): Promise<
    ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>
  > {
    if (this.#sessionId === undefined) await this.initialize();
    const response = await this.#post({
      jsonrpc: "2.0",
      id: ++this.#nextId,
      method: "tools/list",
      params: {},
    });
    const body = (await response.json()) as {
      readonly error?: unknown;
      readonly result?: {
        readonly tools?: ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>;
      };
    };
    if (body.error !== undefined || body.result?.tools === undefined) {
      throw new Error("MCP tools/list failed.");
    }
    return body.result.tools;
  }

  async #post(body: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(this.#endpoint, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${this.#token}`,
          "content-type": "application/json",
          ...(this.#sessionId === undefined ? {} : { "mcp-session-id": this.#sessionId }),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error("MCP request did not complete.");
    }
    if (!response.ok) throw new Error(`MCP request returned HTTP ${response.status}.`);
    return response;
  }
}

export class RealFleetGateDriver implements FleetGateDriver, AsyncDisposable {
  readonly harness: ThreeNodeFleetHarness;
  readonly #repoRoot: string;
  readonly #captureBroker: McpCredentialCaptureBroker;
  readonly #descriptors: Readonly<Record<FleetHarnessNodeName, EnvironmentDescriptor>>;
  readonly #adminTokens: ReadonlyMap<FleetHarnessNodeName, string>;
  readonly #projects: Readonly<Record<FleetHarnessNodeName, string>>;
  readonly #mcp: RealMcpClient;
  readonly #nodeAliases = new Map<string, FleetHarnessNodeName>();
  readonly #threadOwners = new Map<string, FleetHarnessNodeName>();
  readonly #clients = new Map<string, ClientConnectionState>();
  #disposed = false;

  private constructor(input: {
    readonly harness: ThreeNodeFleetHarness;
    readonly repoRoot: string;
    readonly captureBroker: McpCredentialCaptureBroker;
    readonly descriptors: Readonly<Record<FleetHarnessNodeName, EnvironmentDescriptor>>;
    readonly adminTokens: ReadonlyMap<FleetHarnessNodeName, string>;
    readonly projects: Readonly<Record<FleetHarnessNodeName, string>>;
    readonly mcp: RealMcpClient;
  }) {
    this.harness = input.harness;
    this.#repoRoot = input.repoRoot;
    this.#captureBroker = input.captureBroker;
    this.#descriptors = input.descriptors;
    this.#adminTokens = input.adminTokens;
    this.#projects = input.projects;
    this.#mcp = input.mcp;
    for (const name of FLEET_HARNESS_NODE_NAMES) {
      this.#nodeAliases.set(name, name);
      this.#nodeAliases.set(input.descriptors[name].environmentId, name);
    }
  }

  static async start(repoRoot = process.cwd()): Promise<RealFleetGateDriver> {
    const resolvedRepoRoot = NodePath.resolve(repoRoot);
    const harness = await ThreeNodeFleetHarness.make({
      repoRoot: resolvedRepoRoot,
      launchNode: makeSourceServerNodeLauncher(resolvedRepoRoot),
      // Source-mode cold starts build a large Effect layer graph and can exceed
      // 30 seconds on contended CI hosts. The probe still fails immediately if
      // the child exits.
      waitForReady: (node, process) =>
        waitForEnvironmentDescriptor(node, process, {
          timeoutMilliseconds: 120_000,
          pollIntervalMilliseconds: 100,
        }),
    });
    const captureBroker = await McpCredentialCaptureBroker.start(harness.rootDir);

    try {
      const fixturePath = NodePath.join(
        resolvedRepoRoot,
        "apps",
        "server",
        "integration",
        "fleet",
        "fixtures",
        "codex-fleet-gate-peer.mjs",
      );
      const projects = Object.fromEntries(
        await Promise.all(
          FLEET_HARNESS_NODE_NAMES.map(async (name) => {
            const stateDir = NodePath.join(harness.nodes[name].homeDir, "userdata");
            const workspace = NodePath.join(harness.nodes[name].homeDir, "workspace");
            await NodeFSP.mkdir(stateDir, { recursive: true });
            await NodeFSP.mkdir(workspace, { recursive: true });
            await NodeFSP.writeFile(
              NodePath.join(stateDir, "settings.json"),
              `${JSON.stringify(
                {
                  enableProviderUpdateChecks: false,
                  workbenchMasterThreadId: name === "alpha" ? "thread-master-alpha" : "",
                  providerInstances: {
                    codex: {
                      driver: "codex",
                      enabled: true,
                      environment: [
                        {
                          name: "STARCODE_FLEET_MCP_CAPTURE_SOCKET",
                          value: captureBroker.socketPath,
                          sensitive: false,
                        },
                        {
                          name: "STARCODE_FLEET_BOOTSTRAP_CAPTURE_PATH",
                          value: NodePath.join(harness.nodes[name].homeDir, "fleet-bootstrap.txt"),
                          sensitive: false,
                        },
                        ...(name === "alpha"
                          ? [
                              {
                                name: "STARCODE_FLEET_HOLD_FIRST_TURN_MARKER",
                                value: NodePath.join(
                                  harness.nodes.alpha.homeDir,
                                  "hold-first-provider-turn",
                                ),
                                sensitive: false,
                              },
                            ]
                          : []),
                      ],
                      config: {
                        enabled: true,
                        binaryPath: fixturePath,
                        homePath: NodePath.join(harness.nodes[name].homeDir, "codex-home"),
                        customModels: ["gpt-5-codex"],
                      },
                    },
                  },
                  providers: {
                    claudeAgent: { enabled: false },
                    cursor: { enabled: false },
                    grok: { enabled: false },
                    opencode: { enabled: false },
                  },
                },
                null,
                2,
              )}\n`,
              { encoding: "utf8", mode: 0o600 },
            );
            return [name, `project-${name}`] as const;
          }),
        ),
      ) as unknown as Readonly<Record<FleetHarnessNodeName, string>>;

      await harness.start();
      const descriptors = Object.fromEntries(
        await Promise.all(
          FLEET_HARNESS_NODE_NAMES.map(async (name) => [
            name,
            await requestJson<EnvironmentDescriptor>({
              baseUrl: harness.nodes[name].baseUrl,
              path: "/.well-known/t3/environment",
            }),
          ]),
        ),
      ) as unknown as Readonly<Record<FleetHarnessNodeName, EnvironmentDescriptor>>;

      const adminTokens = new Map<FleetHarnessNodeName, string>();
      for (const name of FLEET_HARNESS_NODE_NAMES) {
        const pairingToken = await mintAdministrativePairingToken({
          repoRoot: resolvedRepoRoot,
          homeDir: harness.nodes[name].homeDir,
        });
        const exchanged = await requestJson<{ readonly access_token: string }>({
          baseUrl: harness.nodes[name].baseUrl,
          path: "/oauth/token",
          method: "POST",
          form: new URLSearchParams({
            grant_type: TOKEN_EXCHANGE_GRANT,
            subject_token: pairingToken,
            subject_token_type: BOOTSTRAP_TOKEN_TYPE,
            requested_token_type: ACCESS_TOKEN_TYPE,
            scope: ADMINISTRATIVE_SCOPE,
            client_label: "Fleet integration gate",
            client_device_type: "bot",
          }),
        });
        adminTokens.set(name, exchanged.access_token);
      }

      for (const name of FLEET_HARNESS_NODE_NAMES) {
        const projectId = projects[name];
        await dispatchCommand({
          baseUrl: harness.nodes[name].baseUrl,
          bearerToken: adminTokens.get(name)!,
          command: {
            type: "project.create",
            commandId: `command-project-${name}`,
            projectId,
            title: `Fleet ${name}`,
            workspaceRoot: NodePath.join(harness.nodes[name].homeDir, "workspace"),
            defaultModelSelection: MODEL_SELECTION,
            createdAt: new Date().toISOString(),
          },
        });
        await eventually(`Project ${projectId} was not projected`, async () => {
          const shell = await readShell(harness.nodes[name].baseUrl, adminTokens.get(name)!);
          return shell.projects.some((project) => project.id === projectId);
        });
      }

      const masterThreadId = "thread-master-alpha";
      await dispatchCommand({
        baseUrl: harness.nodes.alpha.baseUrl,
        bearerToken: adminTokens.get("alpha")!,
        command: {
          type: "thread.create",
          commandId: "command-master-create",
          threadId: masterThreadId,
          projectId: projects.alpha,
          title: "Fleet gate master",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: new Date().toISOString(),
        },
      });
      await dispatchThreadTurn({
        baseUrl: harness.nodes.alpha.baseUrl,
        bearerToken: adminTokens.get("alpha")!,
        threadId: masterThreadId,
        message: "Initialize the fleet integration caller.",
      });

      const endpoint = `${harness.nodes.alpha.baseUrl}/mcp`;
      const mcpToken = await captureBroker.take(endpoint);
      const mcp = new RealMcpClient(endpoint, mcpToken);
      await mcp.initialize();

      return new RealFleetGateDriver({
        harness,
        repoRoot: resolvedRepoRoot,
        captureBroker,
        descriptors,
        adminTokens,
        projects,
        mcp,
      });
    } catch (cause) {
      await harness.dispose().catch(() => undefined);
      await captureBroker.close().catch(() => undefined);
      throw cause;
    }
  }

  readonly pair = async (
    requester: FleetHarnessNodeName,
    target: FleetHarnessNodeName,
  ): Promise<void> => {
    const current = await this.#fleetSnapshot(requester);
    if (
      current.members.some(
        (member) => member.node.environmentId === this.#descriptors[target].environmentId,
      )
    ) {
      return;
    }
    const pairingToken = await mintAdministrativePairingToken({
      repoRoot: this.#repoRoot,
      homeDir: this.harness.nodes[target].homeDir,
    });
    await requestJson({
      baseUrl: this.harness.nodes[requester].baseUrl,
      path: "/api/fleet/register",
      method: "POST",
      bearerToken: this.#admin(requester),
      body: {
        name: target,
        baseUrl: this.harness.nodes[target].baseUrl,
        credential: { pairingToken },
        reciprocalBaseUrl: this.harness.nodes[requester].baseUrl,
      },
    });
  };

  readonly remove = async (
    requester: FleetHarnessNodeName,
    target: FleetHarnessNodeName,
  ): Promise<void> => {
    await requestJson({
      baseUrl: this.harness.nodes[requester].baseUrl,
      path: "/api/fleet/remove",
      method: "POST",
      bearerToken: this.#admin(requester),
      body: { environmentId: this.#descriptors[target].environmentId },
    });
  };

  readonly reconcile = async (requester: FleetHarnessNodeName): Promise<void> => {
    await requestJson({
      baseUrl: this.harness.nodes[requester].baseUrl,
      path: "/api/fleet/reconcile",
      method: "POST",
      bearerToken: this.#admin(requester),
      body: {},
    });
    await this.#fleetSnapshot(requester);
  };

  readonly roster = async (requester: FleetHarnessNodeName): Promise<FleetGateRosterSnapshot> => {
    const roster = await this.#fleetSnapshot(requester);
    return {
      selfEnvironmentId: this.#descriptors[requester].environmentId,
      members: [
        ...roster.members.map((member) => ({
          environmentId: member.node.environmentId,
          name: this.#nodeFromEnvironmentId(member.node.environmentId),
          state: "active" as const,
        })),
        ...roster.tombstones.map((tombstone) => ({
          environmentId: tombstone.environmentId,
          name: this.#nodeFromEnvironmentId(tombstone.environmentId),
          state: "tombstone" as const,
        })),
      ],
    };
  };

  readonly readFleetDocument = async (node: FleetHarnessNodeName): Promise<unknown> =>
    JSON.parse(
      await NodeFSP.readFile(
        NodePath.join(this.harness.nodes[node].homeDir, "userdata", "fleet.json"),
        "utf8",
      ),
    ) as unknown;

  readonly setNodeOnline = async (node: FleetHarnessNodeName, online: boolean): Promise<void> => {
    if (!online) {
      await this.harness.stopNode(node);
    } else {
      await this.harness.restartNode(node);
    }
    await Promise.all(
      FLEET_HARNESS_NODE_NAMES.filter((candidate) => candidate !== node).map((candidate) =>
        this.reconcile(candidate).catch(() => undefined),
      ),
    );
  };

  readonly restartNode = async (node: FleetHarnessNodeName): Promise<void> => {
    await this.harness.restartNode(node);
  };

  readonly listThreads = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly node?: FleetHarnessNodeName;
    readonly binding?: FleetGateBinding;
  }): Promise<FleetGateThreadList> => {
    if (input.binding === "deprecated-peer-alias") {
      const result = await this.#mcp.callTool<PeerThreadsListWire>("peer_threads_list", {
        allProjects: true,
        ...(input.node === undefined ? {} : { peer: this.#mcpNode(input.caller, input.node) }),
      });
      const threads = result.threads.map((thread) => {
        const knownOwner = this.#threadOwners.get(thread.threadId);
        const normalized = this.#thread(input.caller, {
          ...thread,
          node: knownOwner ?? thread.peer,
          local: false,
        });
        this.#threadOwners.set(normalized.threadId, normalized.node);
        return normalized;
      });
      return {
        threads,
        failures: result.failures.map((failure) => ({
          node: this.#nodeFromRaw(failure.peer),
          reason: failure.reason,
        })),
      };
    }

    const result = await this.#mcp.callTool<ThreadsListWire>("threads_list", {
      allProjects: true,
      ...(input.node === undefined ? {} : { node: this.#mcpNode(input.caller, input.node) }),
    });
    const threads = result.threads.map((thread) => {
      const normalized = this.#thread(input.caller, thread);
      this.#threadOwners.set(normalized.threadId, normalized.node);
      return normalized;
    });
    return {
      threads,
      failures: result.failures.map((failure) => ({
        node: this.#nodeFromRaw(failure.node),
        reason: failure.reason,
      })),
    };
  };

  readonly readThread = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly threadId: string;
    readonly binding?: FleetGateBinding;
  }): Promise<FleetGateThreadDetail> => {
    const owner = await this.#ownerOf(input.threadId);
    const result =
      input.binding === "deprecated-peer-alias"
        ? await this.#mcp.callTool<PeerThreadReadWire>("peer_thread_read", {
            peer: this.#mcpNode(input.caller, owner),
            threadId: input.threadId,
          })
        : await this.#mcp.callTool<ThreadReadWire>("thread_read", {
            threadId: input.threadId,
          });
    const node = "node" in result ? this.#nodeFromRaw(result.node) : this.#nodeFromRaw(result.peer);
    const thread: FleetGateThread = {
      threadId: result.threadId,
      node,
      project: this.#projects[node],
      title: result.title,
      status: result.status,
      lastActivityAt: new Date().toISOString(),
    };
    this.#threadOwners.set(result.threadId, node);
    return { thread, messages: result.entries.map((entry) => entry.text) };
  };

  readonly sendMessage = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly threadId: string;
    readonly message: string;
    readonly binding?: FleetGateBinding;
  }): Promise<void> => {
    if (input.binding === "deprecated-peer-alias") {
      const owner = await this.#ownerOf(input.threadId);
      await this.#mcp.callTool("peer_thread_send", {
        peer: this.#mcpNode(input.caller, owner),
        threadId: input.threadId,
        message: input.message,
      });
      return;
    }
    await this.#mcp.callTool("thread_send", {
      threadId: input.threadId,
      message: input.message,
    });
  };

  readonly createThread = async (input: {
    readonly caller: FleetHarnessNodeName;
    readonly node?: FleetHarnessNodeName;
    readonly title: string;
    readonly message: string;
    readonly binding?: FleetGateBinding;
  }): Promise<FleetGateThread> => {
    const node = input.node ?? input.caller;
    const common = {
      projectId: this.#projects[node],
      title: input.title,
      message: input.message,
      instanceId: MODEL_SELECTION.instanceId,
      model: MODEL_SELECTION.model,
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    const result =
      input.binding === "deprecated-peer-alias"
        ? await this.#mcp.callTool<{
            readonly peer: string;
            readonly threadId: string;
            readonly title: string;
          }>("peer_thread_create", {
            ...common,
            peer: this.#mcpNode(input.caller, node),
          })
        : await this.#mcp.callTool<{
            readonly node: string;
            readonly local: boolean;
            readonly threadId: string;
            readonly title: string;
          }>("thread_create", {
            ...common,
            node: this.#mcpNode(input.caller, node),
          });
    const normalized: FleetGateThread = {
      threadId: result.threadId,
      node,
      project: this.#projects[node],
      title: result.title,
      status: "idle",
      lastActivityAt: new Date().toISOString(),
    };
    this.#threadOwners.set(result.threadId, node);
    return normalized;
  };

  readonly mcpTools = (): Promise<
    ReadonlyArray<{ readonly name: string; readonly inputSchema: unknown }>
  > => this.#mcp.listTools();

  readonly callMcpTool = <A>(name: string, args: unknown): Promise<A> =>
    this.#mcp.callTool<A>(name, args);

  readonly bootstrapInstructions = (node: FleetHarnessNodeName): Promise<string> =>
    NodeFSP.readFile(
      NodePath.join(this.harness.nodes[node].homeDir, "fleet-bootstrap.txt"),
      "utf8",
    );

  readonly connectClient = async (anchor: FleetHarnessNodeName): Promise<FleetGateClient> => {
    const bootstrap = await requestJson<FleetClientBootstrapWire>({
      baseUrl: this.harness.nodes[anchor].baseUrl,
      path: "/api/fleet/client-bootstrap",
      method: "POST",
      bearerToken: this.#admin(anchor),
      body: {},
    });
    const nodes = new Map<
      FleetHarnessNodeName,
      { readonly baseUrl: string; readonly bearerToken: string }
    >();
    for (const node of bootstrap.nodes) {
      nodes.set(this.#nodeFromEnvironmentId(node.environmentId), {
        baseUrl: node.endpoint.httpBaseUrl,
        bearerToken: node.credential.bearerToken,
      });
    }
    const client = { anchor, clientId: `fleet-client-${NodeCrypto.randomUUID()}` };
    this.#clients.set(client.clientId, { client, nodes, placement: anchor });
    return client;
  };

  /**
   * Write a one-use browser pairing URL without returning or logging the
   * credential. The UI rig keeps the file private and deletes it after the
   * controlled browser consumes it.
   */
  readonly writeBrowserPairingUrl = async (input: {
    readonly node: FleetHarnessNodeName;
    readonly webBaseUrl: string;
    readonly destinationPath: string;
  }): Promise<void> => {
    const pairingToken = await mintAdministrativePairingToken({
      repoRoot: this.#repoRoot,
      homeDir: this.harness.nodes[input.node].homeDir,
    });
    const pairingUrl = new URL("/pair", input.webBaseUrl);
    pairingUrl.hash = new URLSearchParams({ token: pairingToken }).toString();
    await NodeFSP.writeFile(input.destinationPath, pairingUrl.toString(), {
      encoding: "utf8",
      mode: 0o600,
    });
  };

  readonly clientListThreads = async (client: FleetGateClient): Promise<FleetGateThreadList> => {
    const state = this.#client(client);
    const results = await Promise.all(
      [...state.nodes].map(async ([node, connection]) => {
        try {
          const shell = await readShell(connection.baseUrl, connection.bearerToken);
          return {
            threads: shell.threads.map((thread) => {
              const normalized = this.#shellThread(node, thread);
              this.#threadOwners.set(normalized.threadId, node);
              return normalized;
            }),
            failures: [],
          } satisfies FleetGateThreadList;
        } catch {
          return {
            threads: [],
            failures: [{ node, reason: "client connection failed" }],
          } satisfies FleetGateThreadList;
        }
      }),
    );
    return {
      threads: results.flatMap((result) => result.threads),
      failures: results.flatMap((result) => result.failures),
    };
  };

  readonly clientSendMessage = async (
    client: FleetGateClient,
    threadId: string,
    message: string,
  ): Promise<void> => {
    const owner = await this.#ownerOf(threadId);
    const connection = this.#client(client).nodes.get(owner);
    if (connection === undefined) throw new Error(`Client has no connection for ${owner}.`);
    await dispatchThreadTurn({
      baseUrl: connection.baseUrl,
      bearerToken: connection.bearerToken,
      threadId,
      message,
    });
  };

  readonly setClientDefaultPlacement = async (
    client: FleetGateClient,
    node: FleetHarnessNodeName,
  ): Promise<void> => {
    const state = this.#client(client);
    if (!state.nodes.has(node)) throw new Error(`Client has no connection for ${node}.`);
    state.placement = node;
  };

  readonly clientCreateThread = async (
    client: FleetGateClient,
    title: string,
    message: string,
  ): Promise<FleetGateThread> => {
    const state = this.#client(client);
    const node = state.placement;
    const connection = state.nodes.get(node);
    if (connection === undefined) throw new Error(`Client has no connection for ${node}.`);
    const threadId = `thread-client-${NodeCrypto.randomUUID()}`;
    await dispatchCommand({
      baseUrl: connection.baseUrl,
      bearerToken: connection.bearerToken,
      command: {
        type: "thread.create",
        commandId: `command-${NodeCrypto.randomUUID()}`,
        threadId,
        projectId: this.#projects[node],
        title,
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: new Date().toISOString(),
      },
    });
    await dispatchThreadTurn({
      baseUrl: connection.baseUrl,
      bearerToken: connection.bearerToken,
      threadId,
      message,
    });
    const thread: FleetGateThread = {
      threadId,
      node,
      project: this.#projects[node],
      title,
      status: "working",
      lastActivityAt: new Date().toISOString(),
    };
    this.#threadOwners.set(threadId, node);
    return thread;
  };

  readonly diagnoseOnboarding = async (code: FleetOnboardingDiagnosisCode) => ({
    code,
    diagnosis: `Fleet integration diagnosis: ${code.replaceAll("_", " ")}.`,
  });

  readonly onboard = async (input: {
    readonly anchor: FleetHarnessNodeName;
    readonly target: FleetHarnessNodeName;
  }) => {
    await this.pair(input.anchor, input.target);
    return { pairingActs: 1, stages: FLEET_ONBOARDING_STAGES };
  };

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clients.clear();
    this.#threadOwners.clear();
    const cleanup = await Promise.allSettled([this.harness.dispose(), this.#captureBroker.close()]);
    const rejected = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected !== undefined) throw rejected.reason;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  #admin(node: FleetHarnessNodeName): string {
    const token = this.#adminTokens.get(node);
    if (token === undefined) throw new Error(`No administrative session for ${node}.`);
    return token;
  }

  async #fleetSnapshot(node: FleetHarnessNodeName): Promise<FleetRosterWire> {
    const roster = await requestJson<FleetRosterWire>({
      baseUrl: this.harness.nodes[node].baseUrl,
      path: "/api/fleet",
      bearerToken: this.#admin(node),
    });
    for (const member of roster.members) {
      this.#nodeAliases.set(
        member.node.name,
        this.#nodeFromEnvironmentId(member.node.environmentId),
      );
    }
    return roster;
  }

  #nodeFromEnvironmentId(environmentId: string): FleetHarnessNodeName {
    const match = FLEET_HARNESS_NODE_NAMES.find(
      (node) => this.#descriptors[node].environmentId === environmentId,
    );
    if (match === undefined) throw new Error("Fleet returned an unknown environment id.");
    return match;
  }

  #nodeFromRaw(raw: string): FleetHarnessNodeName {
    const alias = this.#nodeAliases.get(raw);
    return alias ?? this.#nodeFromEnvironmentId(raw);
  }

  #mcpNode(_caller: FleetHarnessNodeName, target: FleetHarnessNodeName): string {
    // Environment ids remain stable even when a node adopts a newer
    // fleet-wide display name during roster convergence.
    return this.#descriptors[target].environmentId;
  }

  #thread(caller: FleetHarnessNodeName, thread: ThreadSummaryWire): FleetGateThread {
    return {
      threadId: thread.threadId,
      node: thread.local ? caller : this.#nodeFromRaw(thread.node),
      project: thread.project ?? "unfiled",
      title: thread.title,
      status: thread.status,
      lastActivityAt: thread.lastActivityAt,
    };
  }

  #shellThread(
    node: FleetHarnessNodeName,
    thread: OrchestrationShellWire["threads"][number],
  ): FleetGateThread {
    const status =
      thread.archivedAt !== null
        ? "archived"
        : thread.hasPendingApprovals
          ? "approval"
          : thread.hasPendingUserInput
            ? "input"
            : thread.latestTurn?.state === "running"
              ? "working"
              : thread.latestTurn?.state === "error"
                ? "failed"
                : "idle";
    return {
      threadId: thread.id,
      node,
      project: thread.projectId,
      title: thread.title,
      status,
      lastActivityAt: thread.updatedAt,
    };
  }

  async #ownerOf(threadId: string): Promise<FleetHarnessNodeName> {
    const cached = this.#threadOwners.get(threadId);
    if (cached !== undefined) return cached;
    const listed = await this.listThreads({ caller: "alpha" });
    const found = listed.threads.find((thread) => thread.threadId === threadId);
    if (found === undefined) throw new Error(`Thread ${threadId} was not found in the fleet.`);
    return found.node;
  }

  #client(client: FleetGateClient): ClientConnectionState {
    const state = this.#clients.get(client.clientId);
    if (state === undefined) throw new Error("Unknown fleet integration client.");
    return state;
  }
}

const mintAdministrativePairingToken = async (input: {
  readonly repoRoot: string;
  readonly homeDir: string;
}): Promise<string> => {
  const binPath = NodePath.join(input.repoRoot, "apps", "server", "src", "bin.ts");
  const child = NodeChildProcess.spawn(
    process.execPath,
    [binPath, "pair", "--base-dir", input.homeDir, "--ttl", "10m"],
    {
      cwd: input.repoRoot,
      env: { ...process.env, STARCODE_LOG_LEVEL: "Error" },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (output.length < 1_000_000) output += chunk;
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (exitCode !== 0) throw new Error("The fleet pairing CLI failed.");
  const token = output.match(/(?:^|\n)Token:\s*([^\s]+)/u)?.[1];
  output = "";
  if (token === undefined) throw new Error("The fleet pairing CLI returned no token.");
  return token;
};

const dispatchCommand = async (input: {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly command: unknown;
}): Promise<void> => {
  await requestJson({
    baseUrl: input.baseUrl,
    path: "/api/orchestration/dispatch",
    method: "POST",
    bearerToken: input.bearerToken,
    body: input.command,
  });
};

const dispatchThreadTurn = async (input: {
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly threadId: string;
  readonly message: string;
}): Promise<void> => {
  await dispatchCommand({
    baseUrl: input.baseUrl,
    bearerToken: input.bearerToken,
    command: {
      type: "thread.turn.start",
      commandId: `command-${NodeCrypto.randomUUID()}`,
      threadId: input.threadId,
      message: {
        messageId: `message-${NodeCrypto.randomUUID()}`,
        role: "user",
        text: input.message,
        attachments: [],
      },
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: new Date().toISOString(),
    },
  });
};

const readShell = async (baseUrl: string, bearerToken: string): Promise<OrchestrationShellWire> =>
  await requestJson<OrchestrationShellWire>({
    baseUrl,
    path: "/api/orchestration/shell",
    bearerToken,
  });
