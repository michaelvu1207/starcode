// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalFetch:off globalTimers:off - subprocess fleet integration boundary
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const FLEET_HARNESS_NODE_NAMES = ["alpha", "beta", "gamma"] as const;

export type FleetHarnessNodeName = (typeof FLEET_HARNESS_NODE_NAMES)[number];

export interface FleetHarnessNode {
  readonly name: FleetHarnessNodeName;
  readonly homeDir: string;
  readonly port: number;
  readonly baseUrl: string;
}

export interface FleetHarnessProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface FleetHarnessProcess {
  readonly pid: number | undefined;
  readonly exited: Promise<FleetHarnessProcessExit>;
  readonly stop: () => Promise<void>;
  /**
   * Credential-safe startup diagnostics. Launchers must omit pairing output,
   * bearer tokens, and response bodies from this value.
   */
  readonly failureSummary?: () => string | undefined;
}

export type FleetHarnessNodeLauncher = (node: FleetHarnessNode) => Promise<FleetHarnessProcess>;

export type FleetHarnessReadinessProbe = (
  node: FleetHarnessNode,
  process: FleetHarnessProcess,
) => Promise<void>;

export interface ThreeNodeFleetHarnessOptions {
  /**
   * Repository root containing scripts/dev-runner.ts. Defaults to the current
   * working directory so the rig can be invoked by a focused Vite+ test.
   */
  readonly repoRoot?: string;
  /**
   * Parent for alpha/beta/gamma. Supplying one makes the caller responsible for
   * deleting it; otherwise the harness owns and removes a fresh temporary root.
   */
  readonly rootDir?: string;
  /**
   * Fixed ports make CI failures reproducible. When omitted the harness reserves
   * three available loopback ports before constructing any node.
   */
  readonly ports?: Readonly<Record<FleetHarnessNodeName, number>>;
  readonly launchNode?: FleetHarnessNodeLauncher;
  readonly waitForReady?: FleetHarnessReadinessProbe;
}

export class FleetHarnessLifecycleError extends Error {
  readonly node: FleetHarnessNodeName;
  readonly operation: "start" | "ready" | "restart" | "stop";
  override readonly cause: unknown;

  constructor(input: {
    readonly node: FleetHarnessNodeName;
    readonly operation: "start" | "ready" | "restart" | "stop";
    readonly cause: unknown;
  }) {
    super(`Fleet harness failed to ${input.operation} node ${input.node}.`);
    this.name = "FleetHarnessLifecycleError";
    this.node = input.node;
    this.operation = input.operation;
    this.cause = input.cause;
  }
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const waitForProcessExit = async (
  child: NodeChildProcess.ChildProcess,
  timeoutMilliseconds: number,
): Promise<boolean> =>
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }

    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMilliseconds);
    timeout.unref();

    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });

const safeServerFailureSummary = (output: string): string | undefined => {
  const credentialBearingLine = /authorization|bearer|oauth|pairing|secret|token/iu;
  const failureLine = /address already in use|eaddrinuse|error|failed|service not found/iu;
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && failureLine.test(line) && !credentialBearingLine.test(line),
    )
    .slice(-4);
  return lines.length === 0 ? undefined : lines.join(" ");
};

export const makeDevServerNodeLauncher = (repoRoot: string): FleetHarnessNodeLauncher => {
  const devRunnerPath = NodePath.join(repoRoot, "scripts", "dev-runner.ts");

  return async (node) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        devRunnerPath,
        "dev:server",
        "--home-dir",
        node.homeDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(node.port),
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          STARCODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
          STARCODE_NO_BROWSER: "1",
        },
        // Startup output includes pairing material. Never copy it into test
        // failures or CI artifacts.
        stdio: "ignore",
      },
    );

    const exited = new Promise<FleetHarnessProcessExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    return {
      pid: child.pid,
      exited,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        if (await waitForProcessExit(child, 5_000)) return;
        child.kill("SIGKILL");
        await waitForProcessExit(child, 2_000);
      },
    };
  };
};

/**
 * Starts the source server directly, without Vite+'s watch process. This is the
 * launcher used by the opt-in integration gate: every child has one PID, so
 * stopping gamma really takes gamma offline and cleanup cannot strand a
 * watcher-owned grandchild.
 */
export const makeSourceServerNodeLauncher = (
  repoRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): FleetHarnessNodeLauncher => {
  const serverEntryPath = NodePath.join(repoRoot, "apps", "server", "src", "bin.ts");

  return async (node) => {
    const child = NodeChildProcess.spawn(
      process.execPath,
      [
        serverEntryPath,
        "serve",
        "--base-dir",
        node.homeDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(node.port),
      ],
      {
        cwd: repoRoot,
        env: {
          ...environment,
          STARCODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
          STARCODE_LOG_LEVEL: "Error",
          STARCODE_NO_BROWSER: "1",
        },
        // Headless startup prints pairing material. Capture it only in memory
        // so an early-exit diagnostic can select credential-free error lines.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    const capture = (chunk: Buffer) => {
      if (output.length < 1_000_000) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    const exited = new Promise<FleetHarnessProcessExit>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    return {
      pid: child.pid,
      exited,
      failureSummary: () => safeServerFailureSummary(output),
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill("SIGTERM");
        if (await waitForProcessExit(child, 8_000)) return;
        child.kill("SIGKILL");
        await waitForProcessExit(child, 2_000);
      },
    };
  };
};

export const waitForEnvironmentDescriptor = async (
  node: FleetHarnessNode,
  process: FleetHarnessProcess,
  options: {
    readonly timeoutMilliseconds?: number;
    readonly pollIntervalMilliseconds?: number;
  } = {},
): Promise<void> => {
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  const pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 100;
  const deadline = Date.now() + timeoutMilliseconds;
  const descriptorUrl = new URL("/.well-known/t3/environment", node.baseUrl);

  while (Date.now() < deadline) {
    const result = await Promise.race([
      fetch(descriptorUrl, { signal: AbortSignal.timeout(1_000) })
        .then((response) => (response.ok ? "ready" : "retry"))
        .catch(() => "retry" as const),
      process.exited.then(() => "exited" as const),
    ]);

    if (result === "ready") return;
    if (result === "exited") {
      const detail = process.failureSummary?.();
      throw new Error(
        `Node ${node.name} exited before publishing its environment descriptor.${
          detail === undefined ? "" : ` ${detail}`
        }`,
      );
    }
    await delay(pollIntervalMilliseconds);
  }

  throw new Error(
    `Node ${node.name} did not publish its environment descriptor within ${timeoutMilliseconds}ms.`,
  );
};

const reserveAvailablePorts = async (count: number): Promise<ReadonlyArray<number>> => {
  const reservations: Array<NodeNet.Server> = [];
  try {
    const ports = await Promise.all(
      Array.from({ length: count }, async () => {
        const server = NodeNet.createServer();
        reservations.push(server);
        return await new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") {
              reject(new Error("Loopback port reservation did not return a TCP address."));
              return;
            }
            resolve(address.port);
          });
        });
      }),
    );
    return ports;
  } finally {
    await Promise.all(
      reservations.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
      ),
    );
  }
};

export class ThreeNodeFleetHarness implements AsyncDisposable {
  readonly rootDir: string;
  readonly nodes: Readonly<Record<FleetHarnessNodeName, FleetHarnessNode>>;

  readonly #ownsRootDir: boolean;
  readonly #launchNode: FleetHarnessNodeLauncher;
  readonly #waitForReady: FleetHarnessReadinessProbe;
  readonly #processes = new Map<FleetHarnessNodeName, FleetHarnessProcess>();
  #disposed = false;

  private constructor(input: {
    readonly rootDir: string;
    readonly ownsRootDir: boolean;
    readonly nodes: Readonly<Record<FleetHarnessNodeName, FleetHarnessNode>>;
    readonly launchNode: FleetHarnessNodeLauncher;
    readonly waitForReady: FleetHarnessReadinessProbe;
  }) {
    this.rootDir = input.rootDir;
    this.nodes = input.nodes;
    this.#ownsRootDir = input.ownsRootDir;
    this.#launchNode = input.launchNode;
    this.#waitForReady = input.waitForReady;
  }

  static async make(options: ThreeNodeFleetHarnessOptions = {}): Promise<ThreeNodeFleetHarness> {
    const repoRoot = NodePath.resolve(options.repoRoot ?? process.cwd());
    const ownsRootDir = options.rootDir === undefined;
    const rootDir =
      options.rootDir === undefined
        ? await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-fleet-rig-"))
        : NodePath.resolve(options.rootDir);
    await NodeFSP.mkdir(rootDir, { recursive: true });

    const portValues =
      options.ports === undefined
        ? await reserveAvailablePorts(FLEET_HARNESS_NODE_NAMES.length)
        : FLEET_HARNESS_NODE_NAMES.map((name) => options.ports![name]);
    if (
      new Set(portValues).size !== FLEET_HARNESS_NODE_NAMES.length ||
      portValues.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
    ) {
      if (ownsRootDir) await NodeFSP.rm(rootDir, { recursive: true, force: true });
      throw new Error("Fleet harness ports must be three distinct TCP port numbers.");
    }

    const nodes = Object.fromEntries(
      await Promise.all(
        FLEET_HARNESS_NODE_NAMES.map(async (name, index) => {
          const homeDir = NodePath.join(rootDir, name);
          await NodeFSP.mkdir(homeDir, { recursive: true });
          const port = portValues[index]!;
          return [
            name,
            {
              name,
              homeDir,
              port,
              baseUrl: `http://127.0.0.1:${port}`,
            } satisfies FleetHarnessNode,
          ] as const;
        }),
      ),
    ) as unknown as Readonly<Record<FleetHarnessNodeName, FleetHarnessNode>>;

    return new ThreeNodeFleetHarness({
      rootDir,
      ownsRootDir,
      nodes,
      launchNode: options.launchNode ?? makeDevServerNodeLauncher(repoRoot),
      waitForReady: options.waitForReady ?? waitForEnvironmentDescriptor,
    });
  }

  get runningNodes(): ReadonlyArray<FleetHarnessNodeName> {
    return FLEET_HARNESS_NODE_NAMES.filter((name) => this.#processes.has(name));
  }

  async start(): Promise<void> {
    this.#assertUsable();
    if (this.#processes.size > 0) {
      throw new Error("The three-node fleet harness is already running.");
    }
    const started: Array<FleetHarnessNodeName> = [];
    try {
      // Sequential startup keeps diagnostics attributable to one node and avoids
      // three Vite+ dependency scans racing on a cold CI cache.
      for (const name of FLEET_HARNESS_NODE_NAMES) {
        await this.#startNode(name, "start");
        started.push(name);
      }
    } catch (cause) {
      await Promise.allSettled(started.toReversed().map((name) => this.stopNode(name)));
      throw cause;
    }
  }

  async stopNode(name: FleetHarnessNodeName): Promise<void> {
    const process = this.#processes.get(name);
    if (process === undefined) return;
    this.#processes.delete(name);
    try {
      await process.stop();
    } catch (cause) {
      throw new FleetHarnessLifecycleError({ node: name, operation: "stop", cause });
    }
  }

  async restartNode(name: FleetHarnessNodeName): Promise<void> {
    this.#assertUsable();
    await this.stopNode(name);
    await this.#startNode(name, "restart");
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;

    const stopResults = await Promise.allSettled(
      this.runningNodes.toReversed().map((name) => this.stopNode(name)),
    );
    if (this.#ownsRootDir) {
      await NodeFSP.rm(this.rootDir, { recursive: true, force: true });
    }

    const failedStop = stopResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedStop !== undefined) throw failedStop.reason;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  async #startNode(name: FleetHarnessNodeName, operation: "start" | "restart"): Promise<void> {
    if (this.#processes.has(name)) return;
    const node = this.nodes[name];
    let process: FleetHarnessProcess;
    try {
      process = await this.#launchNode(node);
    } catch (cause) {
      throw new FleetHarnessLifecycleError({ node: name, operation, cause });
    }
    this.#processes.set(name, process);

    try {
      await this.#waitForReady(node, process);
    } catch (cause) {
      this.#processes.delete(name);
      await process.stop().catch(() => undefined);
      throw new FleetHarnessLifecycleError({ node: name, operation: "ready", cause });
    }
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("The three-node fleet harness has already been disposed.");
  }
}
