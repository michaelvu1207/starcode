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
  it("holds no JSX: these are verbs the platform's own menu calls", () => {
    // The `···` popup is gone and right-click is a native menu on desktop and a
    // DOM fallback in a browser — neither renders React. If a menu item creeps
    // back into this file, the two menus have started to disagree about what a
    // row can do, which is the whole thing consolidating them was for.
    expect(actionsSource).not.toContain("<MenuItem");
    expect(actionsSource).not.toContain("<MenuSub");
  });

  it("takes its environment from the thread, never from a hook", () => {
    // The sidebar is one list merged from every connected machine, so which
    // machine a verb talks to is only known at click time. A hook parameterised
    // by environment id here would have to be called per row — the cost this
    // file has always been shaped to avoid.
    expect(actionsSource).not.toContain("useRefreshHistoryImports(");
    expect(actionsSource).not.toContain("useHistoryImports(");
    expect(actionsSource).toContain("refreshHistoryImports(thread.environmentId)");
    expect(actionsSource).toContain("readHistoryImports(thread.environmentId)");
  });

  it("sends the two filing requests in order rather than at once", () => {
    // Unfile-then-exclude is an ordered pair. `Promise.all` over the plan would
    // race them and leave the exclusion applied to a category the unfile then
    // cleared.
    expect(actionsSource).toContain("for (const request of plan) {");
    expect(actionsSource).not.toContain("Promise.all");
  });

  it("refuses to file into an archived project", () => {
    expect(actionsSource).toContain(".filter((project) => !project.archived)");
  });

  it("re-reads the machine it just wrote to, whether or not the write landed", () => {
    // The catalog is polled every 45 seconds and membership has no optimistic
    // overlay, so without this the row sits in its old group for up to a
    // minute. In a `finally`, because a refusal has to put the truth back on
    // screen too.
    const move = actionsSource.slice(actionsSource.indexOf("const moveThreadToProject"));
    expect(move.slice(0, move.indexOf("const canForkWithConversation"))).toContain(
      "} finally {\n        refreshProjectCatalogs([thread.environmentId]);",
    );
  });

  it("offers an Undo on archive rather than a confirm before it", () => {
    // Archive moved from the bottom of a menu you had to open to a button the
    // pointer crosses, and unarchiving otherwise lives in settings. The undo is
    // what pays for that; a confirm dialog on a reversible action you take
    // dozens of times a session is a dialog you learn to dismiss unread.
    const archive = actionsSource.slice(actionsSource.indexOf("const archiveThread = useCallback"));
    expect(archive).toContain('children: "Undo"');
    expect(archive).toContain("unarchiveThread(threadRef)");
  });
});
