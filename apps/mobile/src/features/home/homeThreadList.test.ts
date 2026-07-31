import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@starcode/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@starcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeProjectScopes, sortHomeProjectScopes } from "./homeThreadList";

function makeProject(
  input: Partial<EnvironmentProject> & Pick<EnvironmentProject, "environmentId" | "id" | "title">,
): EnvironmentProject {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<EnvironmentThreadShell> &
    Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "title">,
): EnvironmentThreadShell {
  return {
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("fleet project catalog", () => {
  it("builds one logical project from copies on multiple machines", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/starcode",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/starcode.git",
      },
    };
    const projects = [
      makeProject({
        environmentId: localEnvironmentId,
        id: ProjectId.make("project-local"),
        title: "starcode",
        repositoryIdentity,
      }),
      makeProject({
        environmentId: remoteEnvironmentId,
        id: ProjectId.make("project-remote"),
        title: "starcode",
        repositoryIdentity,
      }),
    ];

    const scopes = buildHomeProjectScopes({
      projects,
      projectGroupingMode: "repository",
    });

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.projects).toEqual(projects);
    expect(scopes[0]?.projectRefs).toEqual(
      projects.map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
      })),
    );
  });

  it("keeps stale physical project refs in the logical fleet scope", () => {
    const environmentId = EnvironmentId.make("environment-remote");
    const repositoryIdentity = {
      canonicalKey: "github.com/pingdotgg/starcode",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:pingdotgg/starcode.git",
      },
    };
    const stale = makeProject({
      environmentId,
      id: ProjectId.make("project-stale"),
      title: "starcode",
      workspaceRoot: "/workspaces/starcode",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    const current = makeProject({
      environmentId,
      id: ProjectId.make("project-current"),
      title: "starcode",
      workspaceRoot: "/workspaces/starcode/",
      repositoryIdentity,
      updatedAt: "2026-06-02T00:00:00.000Z",
    });

    const [scope] = buildHomeProjectScopes({
      projects: [stale, current],
      projectGroupingMode: "repository",
    });

    expect(scope?.projects.map((project) => project.id)).toEqual([current.id]);
    expect(scope?.projectRefs.map((ref) => ref.projectId)).toEqual([stale.id, current.id]);
  });

  it("does not merge unrelated repositories that share a title", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const projects = ["one", "two"].map((name) =>
      makeProject({
        environmentId,
        id: ProjectId.make(`project-${name}`),
        title: "app",
        repositoryIdentity: {
          canonicalKey: `github.com/example/${name}`,
          locator: {
            source: "git-remote" as const,
            remoteName: "origin",
            remoteUrl: `git@github.com:example/${name}.git`,
          },
        },
      }),
    );

    expect(
      buildHomeProjectScopes({
        projects,
        projectGroupingMode: "repository",
      }),
    ).toHaveLength(2);
  });

  it("sorts logical projects by activity from any machine copy", () => {
    const localEnvironmentId = EnvironmentId.make("environment-local");
    const remoteEnvironmentId = EnvironmentId.make("environment-remote");
    const localProject = makeProject({
      environmentId: localEnvironmentId,
      id: ProjectId.make("project-local"),
      title: "Local",
    });
    const remoteProject = makeProject({
      environmentId: remoteEnvironmentId,
      id: ProjectId.make("project-remote"),
      title: "Remote",
    });
    const scopes = buildHomeProjectScopes({
      projects: [localProject, remoteProject],
      projectGroupingMode: "separate",
    });

    expect(
      sortHomeProjectScopes({
        scopes,
        threads: [
          makeThread({
            environmentId: remoteEnvironmentId,
            id: ThreadId.make("thread-remote"),
            projectId: remoteProject.id,
            title: "Newest",
            updatedAt: "2026-06-03T00:00:00.000Z",
          }),
          makeThread({
            environmentId: localEnvironmentId,
            id: ThreadId.make("thread-local"),
            projectId: localProject.id,
            title: "Older",
            updatedAt: "2026-06-02T00:00:00.000Z",
          }),
        ],
        pendingTasks: [],
        projectSortOrder: "updated_at",
      }).map((scope) => scope.representative.id),
    ).toEqual([remoteProject.id, localProject.id]);
  });
});
