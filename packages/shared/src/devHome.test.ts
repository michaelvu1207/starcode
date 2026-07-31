// @effect-diagnostics nodeBuiltinImport:off - builds representative worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import { resolveGitWorktreePath, resolveWorktreeStarCodeHome } from "./devHome.ts";

const makeRepo = (kind: "worktree" | "checkout" | "bare" | "submodule" | "bare-repo-worktree") =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "starcode-devhome-"));
      if (kind === "worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/x\n");
      } else if (kind === "bare-repo-worktree") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: /srv/app.git/worktrees/x\n");
      } else if (kind === "submodule") {
        NodeFS.writeFileSync(NodePath.join(root, ".git"), "gitdir: ../.git/modules/sub\n");
      } else if (kind === "checkout") {
        NodeFS.mkdirSync(NodePath.join(root, ".git"));
      }
      const nested = NodePath.join(root, "apps", "web", "src");
      NodeFS.mkdirSync(nested, { recursive: true });
      return { root, nested };
    }),
    ({ root }) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );

describe("resolveGitWorktreePath", () => {
  it.effect("finds a worktree root from a nested directory", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  for (const kind of ["checkout", "bare", "submodule"] as const) {
    it.effect(`does not classify a ${kind} as a linked worktree`, () =>
      Effect.gen(function* () {
        const { nested } = yield* makeRepo(kind);
        assert.equal(yield* resolveGitWorktreePath(nested), undefined);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }

  it.effect("finds a worktree of a bare repository", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("bare-repo-worktree");
      assert.equal(yield* resolveGitWorktreePath(nested), NodePath.resolve(root));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveWorktreeStarCodeHome", () => {
  it.effect("answers with .starcode before the dev runner creates it", () =>
    Effect.gen(function* () {
      const { root, nested } = yield* makeRepo("worktree");
      const home = yield* resolveWorktreeStarCodeHome(nested);
      assert.equal(home, NodePath.join(NodePath.resolve(root), ".starcode"));
      assert.isFalse(NodeFS.existsSync(home ?? ""));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
