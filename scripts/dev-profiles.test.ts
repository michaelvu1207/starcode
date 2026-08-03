import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { ProjectCategoryRecord } from "@starcode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  ensurePersonalProfile,
  parseDevProfileCli,
  profileDirectory,
  resetFixtureProfile,
  seedFixtureProfile,
  snapshotDatabase,
} from "./dev-profiles.ts";

const decodeProjectCategoryRecord = Schema.decodeUnknownSync(ProjectCategoryRecord);

async function makeTemporaryRoot(): Promise<string> {
  return NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "starcode-dev-profiles-"));
}

async function readFile(path: string): Promise<string | undefined> {
  return NodeFSP.readFile(path, "utf8").catch(() => undefined);
}

function writeDatabase(path: string, projectTitle: string): void {
  const database = new NodeSqlite.DatabaseSync(path);
  try {
    database.exec("CREATE TABLE projects (title TEXT NOT NULL)");
    database.prepare("INSERT INTO projects (title) VALUES (?)").run(projectTitle);
  } finally {
    database.close();
  }
}

describe("dev profiles", () => {
  it("keeps automatic pairing for humans while allowing controlled browser automation", () => {
    assert.equal(parseDevProfileCli(["personal"]).browser, true);
    assert.equal(parseDevProfileCli(["fixture", "--no-browser"]).browser, false);
  });

  it("snapshots the live database and only copies curated support files by default", async () => {
    const root = await makeTemporaryRoot();
    try {
      const sharedHome = NodePath.join(root, "shared");
      const sharedState = NodePath.join(sharedHome, "userdata");
      await NodeFSP.mkdir(NodePath.join(sharedState, "attachments"), { recursive: true });
      writeDatabase(NodePath.join(sharedState, "state.sqlite"), "Live project");
      await NodeFSP.writeFile(NodePath.join(sharedState, "settings.json"), '{"theme":"dark"}');
      await NodeFSP.writeFile(NodePath.join(sharedState, "attachments", "note.txt"), "attachment");
      await NodeFSP.mkdir(NodePath.join(sharedState, "secrets"));
      await NodeFSP.writeFile(NodePath.join(sharedState, "secrets", "token"), "secret");
      await NodeFSP.writeFile(NodePath.join(sharedState, "server.log"), "not copied");

      const result = await ensurePersonalProfile({
        repoRoot: NodePath.join(root, "repo"),
        sharedHome,
        refresh: false,
        includeSecrets: false,
      });

      assert.equal(result.reused, false);
      assert.equal(result.copiedDatabase, true);
      const copiedDatabase = new NodeSqlite.DatabaseSync(
        NodePath.join(result.directory, "userdata", "state.sqlite"),
        { readOnly: true },
      );
      try {
        assert.deepStrictEqual(copiedDatabase.prepare("SELECT title FROM projects").all(), [
          { title: "Live project" },
        ]);
      } finally {
        copiedDatabase.close();
      }
      assert.equal(
        await readFile(NodePath.join(result.directory, "userdata", "settings.json")),
        '{"theme":"dark"}',
      );
      assert.equal(
        await readFile(NodePath.join(result.directory, "userdata", "attachments", "note.txt")),
        "attachment",
      );
      assert.equal(
        await readFile(NodePath.join(result.directory, "userdata", "secrets", "token")),
        undefined,
      );
      assert.equal(
        await readFile(NodePath.join(result.directory, "userdata", "server.log")),
        undefined,
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses personal state until an explicit refresh and only then includes secrets", async () => {
    const root = await makeTemporaryRoot();
    try {
      const repoRoot = NodePath.join(root, "repo");
      const sharedHome = NodePath.join(root, "shared");
      const sharedState = NodePath.join(sharedHome, "userdata");
      await NodeFSP.mkdir(NodePath.join(sharedState, "secrets"), { recursive: true });
      writeDatabase(NodePath.join(sharedState, "state.sqlite"), "First");
      await NodeFSP.writeFile(NodePath.join(sharedState, "secrets", "token"), "secret");
      await ensurePersonalProfile({ repoRoot, sharedHome, refresh: false, includeSecrets: false });
      const reused = await ensurePersonalProfile({
        repoRoot,
        sharedHome,
        refresh: false,
        includeSecrets: true,
      });
      assert.equal(reused.reused, true);
      assert.equal(
        await readFile(
          NodePath.join(profileDirectory(repoRoot, "personal"), "userdata", "secrets", "token"),
        ),
        undefined,
      );

      const refreshed = await ensurePersonalProfile({
        repoRoot,
        sharedHome,
        refresh: true,
        includeSecrets: true,
      });
      assert.equal(refreshed.reused, false);
      assert.equal(
        await readFile(
          NodePath.join(profileDirectory(repoRoot, "personal"), "userdata", "secrets", "token"),
        ),
        "secret",
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a personal profile symlink instead of reusing shared state", async () => {
    const root = await makeTemporaryRoot();
    try {
      const repoRoot = NodePath.join(root, "repo");
      const sharedHome = NodePath.join(root, "shared");
      await NodeFSP.mkdir(NodePath.join(repoRoot, ".starcode"), { recursive: true });
      await NodeFSP.mkdir(NodePath.join(sharedHome, "userdata"), { recursive: true });
      writeDatabase(NodePath.join(sharedHome, "userdata", "state.sqlite"), "Live");
      await NodeFSP.symlink(sharedHome, profileDirectory(repoRoot, "personal"));

      const error = await ensurePersonalProfile({
        repoRoot,
        sharedHome,
        refresh: false,
        includeSecrets: false,
      }).then(
        () => undefined,
        (cause: unknown) => cause,
      );
      assert.ok(error instanceof Error);
      assert.include(error.message, "symlinked dev-profile path");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("takes a consistent SQLite WAL snapshot without mutating the source", async () => {
    const root = await makeTemporaryRoot();
    try {
      const source = NodePath.join(root, "source.sqlite");
      const destination = NodePath.join(root, "snapshot.sqlite");
      const sourceDatabase = new NodeSqlite.DatabaseSync(source);
      try {
        sourceDatabase.exec("PRAGMA journal_mode = WAL");
        sourceDatabase.exec("CREATE TABLE projects (title TEXT NOT NULL)");
        sourceDatabase.prepare("INSERT INTO projects (title) VALUES (?)").run("Live project");
        assert.equal(await snapshotDatabase(source, destination), true);
        assert.deepStrictEqual(sourceDatabase.prepare("SELECT title FROM projects").all(), [
          { title: "Live project" },
        ]);
      } finally {
        sourceDatabase.close();
      }
      const snapshot = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
      try {
        assert.deepStrictEqual(snapshot.prepare("SELECT title FROM projects").all(), [
          { title: "Live project" },
        ]);
      } finally {
        snapshot.close();
      }
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("resets only the worktree fixture profile", async () => {
    const root = await makeTemporaryRoot();
    try {
      const repoRoot = NodePath.join(root, "repo");
      const fixture = profileDirectory(repoRoot, "fixture");
      await NodeFSP.mkdir(fixture, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(fixture, "stale.txt"), "stale");
      const reset = await resetFixtureProfile(repoRoot);
      assert.equal(reset, fixture);
      assert.equal(await readFile(NodePath.join(fixture, "stale.txt")), undefined);
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("seeds a stable project, representative threads, and messages", async () => {
    const directory = await makeTemporaryRoot();
    try {
      await seedFixtureProfile(process.cwd(), directory);
      const catalog = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(directory, "userdata", "project-catalog.json"),
          "utf8",
        ),
      ) as { readonly categories: ReadonlyArray<unknown> };
      const category = decodeProjectCategoryRecord(catalog.categories[0]);
      assert.deepStrictEqual(
        category.local.bindings.map(({ projectId, boundAt }) => ({
          projectId: String(projectId),
          boundAt,
        })),
        [{ projectId: "starcode", boundAt: "1970-01-01T00:00:00.000Z" }],
      );
      const database = new NodeSqlite.DatabaseSync(
        NodePath.join(directory, "userdata", "state.sqlite"),
        {
          readOnly: true,
        },
      );
      try {
        assert.deepStrictEqual(
          database
            .prepare(
              "SELECT (SELECT COUNT(*) FROM projection_projects) AS projects, (SELECT COUNT(*) FROM projection_threads) AS threads, (SELECT COUNT(*) FROM projection_thread_messages) AS messages",
            )
            .get(),
          { projects: 1, threads: 2, messages: 4 },
        );
      } finally {
        database.close();
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
