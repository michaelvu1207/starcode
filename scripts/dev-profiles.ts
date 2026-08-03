#!/usr/bin/env node

/**
 * Starts the ordinary web dev stack with a worktree-owned profile.
 *
 * `personal` makes a SQLite-consistent copy of the installed application's
 * state. It intentionally never points a dev process at ~/.starcode.
 * `fixture` starts from a fresh, worktree-owned database and lets the server
 * create the current project and its first thread.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";

import { seedShowcaseEnvironment } from "./mobile-showcase-environment.ts";

export type DevProfile = "fixture" | "personal";

export interface DevProfileOptions {
  readonly profile: DevProfile;
  readonly repoRoot: string;
  readonly sharedHome: string;
  readonly refresh: boolean;
  readonly includeSecrets: boolean;
}

const CURATED_STATE_FILES = [
  "keybindings.json",
  "settings.json",
  "history-imports.json",
  "project-catalog.json",
  "feature-map.json",
  "usage-model-aliases.json",
] as const;
const CURATED_STATE_DIRECTORIES = ["attachments"] as const;

export function profileDirectory(repoRoot: string, profile: DevProfile): string {
  return NodePath.join(repoRoot, ".starcode", profile);
}

function sqliteString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function exists(path: string): Promise<boolean> {
  return NodeFSP.access(path)
    .then(() => true)
    .catch(() => false);
}

async function assertNoSymlinks(path: string): Promise<void> {
  const info = await NodeFSP.lstat(path).catch(() => undefined);
  if (!info) return;
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing symlinked dev-profile path: ${path}`);
  }
  if (!info.isDirectory()) return;
  for (const entry of await NodeFSP.readdir(path)) {
    await assertNoSymlinks(NodePath.join(path, entry));
  }
}

async function assertProfilePathIsWorktreeOwned(
  repoRoot: string,
  destination: string,
): Promise<void> {
  const profileParent = NodePath.join(repoRoot, ".starcode");
  if (
    NodePath.relative(repoRoot, destination) !==
    NodePath.join(".starcode", NodePath.basename(destination))
  ) {
    throw new Error(`Refusing dev profile outside the worktree: ${destination}`);
  }
  const parentInfo = await NodeFSP.lstat(profileParent).catch(() => undefined);
  if (parentInfo?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked dev-profile path: ${profileParent}`);
  }
  await assertNoSymlinks(destination);
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  if (!(await exists(source))) return;
  await assertNoSymlinks(source);
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  await NodeFSP.cp(source, destination, { recursive: true, force: true, preserveTimestamps: true });
}

/**
 * SQLite's VACUUM INTO takes a transactionally consistent snapshot even when
 * the installed application has an active WAL. Opening the source read-only
 * prevents this helper from writing to the user's live database.
 */
export async function snapshotDatabase(source: string, destination: string): Promise<boolean> {
  if (!(await exists(source))) return false;
  await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
  const database = new NodeSqlite.DatabaseSync(source, { readOnly: true });
  try {
    database.exec(`VACUUM INTO ${sqliteString(destination)}`);
  } finally {
    database.close();
  }
  await NodeFSP.chmod(destination, 0o600);
  return true;
}

async function copyPersonalSupportingState(
  sourceStateDir: string,
  destinationStateDir: string,
  includeSecrets: boolean,
): Promise<void> {
  for (const name of CURATED_STATE_FILES) {
    await copyIfPresent(
      NodePath.join(sourceStateDir, name),
      NodePath.join(destinationStateDir, name),
    );
  }
  for (const name of CURATED_STATE_DIRECTORIES) {
    await copyIfPresent(
      NodePath.join(sourceStateDir, name),
      NodePath.join(destinationStateDir, name),
    );
  }
  if (includeSecrets) {
    await copyIfPresent(
      NodePath.join(sourceStateDir, "secrets"),
      NodePath.join(destinationStateDir, "secrets"),
    );
  }
}

async function replaceDirectory(nextDirectory: string, destination: string): Promise<void> {
  const backup = `${destination}.previous-${NodeCrypto.randomUUID()}`;
  const destinationExists = await exists(destination);
  try {
    if (destinationExists) await NodeFSP.rename(destination, backup);
    await NodeFSP.rename(nextDirectory, destination);
    if (destinationExists) await NodeFSP.rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (destinationExists && !(await exists(destination)) && (await exists(backup))) {
      await NodeFSP.rename(backup, destination);
    }
    throw error;
  }
}

/** Makes or refreshes a persistent personal profile without touching shared state. */
export async function ensurePersonalProfile(options: Omit<DevProfileOptions, "profile">): Promise<{
  readonly directory: string;
  readonly copiedDatabase: boolean;
  readonly reused: boolean;
}> {
  const destination = profileDirectory(options.repoRoot, "personal");
  await assertProfilePathIsWorktreeOwned(options.repoRoot, destination);
  const existingDatabase = NodePath.join(destination, "userdata", "state.sqlite");
  if (!options.refresh && (await exists(existingDatabase))) {
    return { directory: destination, copiedDatabase: true, reused: true };
  }

  const profileParent = NodePath.dirname(destination);
  await NodeFSP.mkdir(profileParent, { recursive: true });
  const nextDirectory = await NodeFSP.mkdtemp(NodePath.join(profileParent, ".personal-next-"));
  try {
    const sourceStateDir = NodePath.join(options.sharedHome, "userdata");
    const copiedDatabase = await snapshotDatabase(
      NodePath.join(sourceStateDir, "state.sqlite"),
      NodePath.join(nextDirectory, "userdata", "state.sqlite"),
    );
    await copyPersonalSupportingState(
      sourceStateDir,
      NodePath.join(nextDirectory, "userdata"),
      options.includeSecrets,
    );
    await replaceDirectory(nextDirectory, destination);
    return { directory: destination, copiedDatabase, reused: false };
  } catch (error) {
    await NodeFSP.rm(nextDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** Fixture state is deliberately recreated so every invocation starts clean. */
export async function resetFixtureProfile(repoRoot: string): Promise<string> {
  const destination = profileDirectory(repoRoot, "fixture");
  await assertProfilePathIsWorktreeOwned(repoRoot, destination);
  await NodeFSP.rm(destination, { recursive: true, force: true });
  await NodeFSP.mkdir(destination, { recursive: true });
  return destination;
}

function runNodeCommand(args: ReadonlyArray<string>, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(NodeProcess.execPath, args, {
      cwd,
      env: NodeProcess.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(new Error(`Fixture setup command exited with ${signal ?? `code ${String(code)}`}.`));
    });
  });
}

/**
 * Uses the normal project command to initialize the schema, then the existing
 * showcase fixture to populate a stable project, thread, and representative
 * conversation. The fixture lives entirely below the worktree's .starcode.
 */
export async function seedFixtureProfile(repoRoot: string, directory: string): Promise<void> {
  await runNodeCommand(
    ["apps/server/src/bin.ts", "project", "add", repoRoot, "--base-dir", directory],
    repoRoot,
  );
  await seedShowcaseEnvironment({ baseDir: directory, projectIds: ["starcode"], now: 0 });
  const database = new NodeSqlite.DatabaseSync(
    NodePath.join(directory, "userdata", "state.sqlite"),
  );
  try {
    // `project add` exists only to initialize the current schema. Its event is
    // not part of the showcase fixture and would otherwise replay at startup.
    database.exec("DELETE FROM orchestration_command_receipts");
    database.exec("DELETE FROM orchestration_events");
  } finally {
    database.close();
  }
  // The projects sidebar groups server projects through the machine-local
  // project catalog. A projection-only fixture therefore looks empty after
  // pairing even though its database rows exist. Bind the showcase project in
  // the supported catalog file as part of the fixture profile.
  const timestamp = "1970-01-01T00:00:00.000Z";
  await NodeFSP.writeFile(
    NodePath.join(directory, "userdata", "project-catalog.json"),
    `${JSON.stringify(
      {
        version: 1,
        categories: [
          {
            slug: "starcode",
            createdAt: timestamp,
            display: {
              title: "Starcode",
              summary: "A deterministic local development fixture.",
              accent: "",
              glyph: "",
              icon: "",
              parentSlug: null,
              links: [],
              notes: "",
              archivedAt: null,
              updatedAt: timestamp,
            },
            local: {
              bindings: [{ projectId: "starcode", boundAt: timestamp }],
              threadIds: [],
              excludedThreadIds: [],
              masterThreadId: "",
              masterDefaults: {},
              defaults: {},
              updatedAt: timestamp,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

function repoRootFromCwd(cwd: string): string {
  return NodeChildProcess.execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export function parseDevProfileCli(argv: ReadonlyArray<string>): {
  readonly profile: DevProfile;
  readonly refresh: boolean;
  readonly includeSecrets: boolean;
  readonly browser: boolean;
} {
  const [profile, ...rawFlags] = argv;
  const flags = rawFlags.filter((flag) => flag !== "--");
  if (profile !== "personal" && profile !== "fixture") {
    throw new Error(
      "Usage: vp run dev:personal [--refresh] [--include-secrets] [--no-browser] | vp run dev:fixture [--no-browser]",
    );
  }
  const unknown = flags.find(
    (flag) => flag !== "--refresh" && flag !== "--include-secrets" && flag !== "--no-browser",
  );
  if (unknown) throw new Error(`Unknown dev-profile option: ${unknown}`);
  if (profile === "fixture" && flags.some((flag) => flag !== "--no-browser")) {
    throw new Error(
      "dev:fixture only accepts --no-browser; it always starts with a fresh fixture.",
    );
  }
  return {
    profile,
    refresh: flags.includes("--refresh"),
    includeSecrets: flags.includes("--include-secrets"),
    browser: !flags.includes("--no-browser"),
  };
}

export async function prepareDevProfile(options: DevProfileOptions): Promise<{
  readonly directory: string;
  readonly message: string;
}> {
  if (options.profile === "fixture") {
    const directory = await resetFixtureProfile(options.repoRoot);
    await seedFixtureProfile(options.repoRoot, directory);
    return {
      directory,
      message: `Fixture profile reset and seeded at ${directory} with a project, thread, and conversation.`,
    };
  }
  const result = await ensurePersonalProfile(options);
  if (result.reused) {
    return {
      directory: result.directory,
      message: `Reusing personal profile at ${result.directory}.`,
    };
  }
  return {
    directory: result.directory,
    message: result.copiedDatabase
      ? `Created a private SQLite snapshot at ${result.directory}.`
      : `No installed Starcode database was found; created an empty personal profile at ${result.directory}.`,
  };
}

async function main(): Promise<void> {
  const cli = parseDevProfileCli(NodeProcess.argv.slice(2));
  const repoRoot = repoRootFromCwd(NodeProcess.cwd());
  const result = await prepareDevProfile({
    profile: cli.profile,
    repoRoot,
    sharedHome: NodePath.join(NodeOS.homedir(), ".starcode"),
    refresh: cli.refresh,
    includeSecrets: cli.includeSecrets,
  });
  NodeProcess.stdout.write(`[dev-profile] ${result.message}\n`);
  if (cli.profile === "personal" && cli.refresh) {
    NodeProcess.stdout.write("[dev-profile] Refreshed from ~/.starcode without writing to it.\n");
  }
  if (cli.includeSecrets) {
    NodeProcess.stdout.write(
      "[dev-profile] userdata/secrets is included only when this profile is created or refreshed. Keep this worktree private.\n",
    );
  }

  const child = NodeChildProcess.spawn(
    NodeProcess.execPath,
    [
      "scripts/dev-runner.ts",
      "dev",
      "--home-dir",
      result.directory,
      ...(cli.profile === "personal"
        ? ["--auto-bootstrap-project-from-cwd"]
        : ["--auto-bootstrap-project-from-cwd=false"]),
      ...(cli.browser ? ["--browser"] : []),
    ],
    { cwd: repoRoot, env: NodeProcess.env, stdio: "inherit" },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT") resolve();
      else reject(new Error(`Dev runner exited with ${signal ?? `code ${String(code)}`}.`));
    });
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
