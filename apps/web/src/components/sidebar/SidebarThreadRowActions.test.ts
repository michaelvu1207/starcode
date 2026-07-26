import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import actionsSource from "./SidebarThreadRowActions.tsx?raw";
import { canForkConversation, forkThreadTitle } from "./SidebarThreadRowActions";

const shell = (session: unknown): Pick<EnvironmentThreadShell, "session"> =>
  ({ session }) as Pick<EnvironmentThreadShell, "session">;

describe("canForkConversation", () => {
  it("carries the conversation for a Claude thread that has spoken", () => {
    expect(canForkConversation({ driverKind: "claudeAgent", thread: shell({}) })).toBe(true);
  });

  it("carries the conversation an imported thread inherited before it has spoken", () => {
    // The case this exists for. An imported thread has hundreds of messages in
    // the model's context and no session of its own yet, so the plain
    // `session !== null` test calls it empty — and a fork taken on that answer
    // silently drops everything the thread was imported to keep.
    expect(
      canForkConversation({
        driverKind: "claudeAgent",
        thread: shell(null),
        inheritedConversation: true,
      }),
    ).toBe(true);
  });

  it("still says setup-only for a Claude thread with nothing behind it", () => {
    expect(
      canForkConversation({
        driverKind: "claudeAgent",
        thread: shell(null),
        inheritedConversation: false,
      }),
    ).toBe(false);
  });

  it("never carries a conversation on a driver that cannot fork a session", () => {
    // Codex resumes into the same rollout, so a "fork" there would be two
    // threads appending to one transcript. Inherited or not, the answer is no.
    expect(
      canForkConversation({
        driverKind: "codex",
        thread: shell({}),
        inheritedConversation: true,
      }),
    ).toBe(false);
  });
});

describe("forkThreadTitle", () => {
  it("names the fork after the thread it came from", () => {
    expect(forkThreadTitle("Teach the sidebar one row")).toBe("Teach the sidebar one row (fork)");
  });

  it("forks a fork without losing where it came from", () => {
    expect(forkThreadTitle("Rewrite the parser (fork)")).toBe("Rewrite the parser (fork) (fork)");
  });

  it("keeps the title short enough to still truncate in a row", () => {
    const title = forkThreadTitle("x".repeat(400));

    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith(" (fork)")).toBe(true);
    // Elided rather than chopped, so the row says the name was cut.
    expect(title).toContain("…");
  });

  it("does not produce an empty title from a padded one", () => {
    // `thread.create` refuses a blank title, and a row whose name is whitespace
    // would fail at the server rather than in the menu.
    expect(forkThreadTitle("  spaced  ")).toBe("spaced (fork)");
  });
});

describe("SidebarThreadRowActions source", () => {
  // The popup is portalled to the body, but a React portal's events bubble up
  // the *component* tree, so an unguarded click on any of these reaches the row
  // and navigates — the row is a click target. Every handler here has to stop
  // it, and this is the assertion that notices when the next one forgets.
  it("stops every menu click from reaching the row underneath", () => {
    const handlers = actionsSource.match(/onClick=\{/g) ?? [];
    const stops = actionsSource.match(/event\.stopPropagation\(\)/g) ?? [];

    expect(handlers.length).toBeGreaterThanOrEqual(4);
    expect(stops.length).toBeGreaterThanOrEqual(handlers.length);
  });

  it("sends the two filing requests in order rather than at once", () => {
    // Unfile-then-exclude is an ordered pair. `Promise.all` over the plan would
    // race them and leave the exclusion applied to a category the unfile then
    // cleared.
    expect(actionsSource).toContain("for (const request of plan) {");
    expect(actionsSource).not.toContain("Promise.all");
  });

  it("refuses to file into an archived project", () => {
    expect(actionsSource).toContain("view.projects.filter((project) => !project.archived)");
  });

  it("hides the submenu when there is nothing to file into and nothing to unfile", () => {
    expect(actionsSource).toContain(
      "if (targets.length === 0 && state.currentSlug === null) return null;",
    );
  });

  it("re-reads the machine it just wrote to, whether or not the write landed", () => {
    // The catalog is polled every 45 seconds and membership has no optimistic
    // overlay, so without this the row sits in its old group for up to a
    // minute. In a `finally`, because a refusal has to put the truth back on
    // screen too.
    const move = actionsSource.slice(actionsSource.indexOf("const move = useCallback"));
    expect(move.slice(0, move.indexOf("</MenuSub>"))).toContain(
      "} finally {\n          refreshProjectCatalogs([thread.environmentId]);",
    );
  });
});
