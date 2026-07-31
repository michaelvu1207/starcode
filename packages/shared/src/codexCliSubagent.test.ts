import { describe, expect, it } from "vite-plus/test";

import { detectCodexCliSubagent } from "./codexCliSubagent.ts";

describe("detectCodexCliSubagent", () => {
  it("detects an exact foreground codex exec and reads only exposed CLI facts", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command:
          'codex exec -m gpt-5.6-sol -s read-only -C /work "Inspect the route graph and report risks." 2>&1 | tail -60',
      }),
    ).toEqual({
      description: "Inspect the route graph and report risks.",
      prompt: "Inspect the route graph and report risks.",
      model: "gpt-5.6-sol",
      cwd: "/work",
      detached: false,
    });
  });

  it("detects wrapped and concurrent invocations without relying on cwd or time", () => {
    expect(
      detectCodexCliSubagent("Shell", {
        command: 'cd /work && env FOO=bar nohup /opt/bin/codex exec --json "Worker two" &',
      }),
    ).toEqual({
      description: "Worker two",
      prompt: "Worker two",
      shellCwd: "/work",
      detached: true,
    });
  });

  it("preserves a preceding cd separately from a relative -C for rollout lookup", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command:
          'cd /work/phase2-router && nohup codex exec -C . -m gpt-5.6-sol "Run the assignment." > /tmp/codex.log 2>&1 &',
      }),
    ).toEqual({
      description: "Run the assignment.",
      prompt: "Run the assignment.",
      model: "gpt-5.6-sol",
      shellCwd: "/work/phase2-router",
      cwd: ".",
      detached: true,
    });
  });

  it("handles setup lines and shell line continuations around a real detached launch", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command: `mkdir -p /tmp/worker
cd /work/phase2-router && \\
nohup codex exec \\
  -C . \\
  --enable multi_agent \\
  -m gpt-5.6-sol \\
  "First line of a long assignment.

Second line of the assignment." \\
  > /tmp/codex.log 2>&1 &
echo "worker launched"`,
      }),
    ).toEqual({
      description: "First line of a long assignment. Second line of the assignment.",
      prompt: "First line of a long assignment.\n\nSecond line of the assignment.",
      model: "gpt-5.6-sol",
      shellCwd: "/work/phase2-router",
      cwd: ".",
      detached: true,
    });
  });

  it("detects a launch but withholds nonliteral prompt and cwd evidence", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command:
          'cd "$WORKTREE" && nohup codex exec -C "$SUBDIR" "$PROMPT" > /tmp/codex.log 2>&1 &',
      }),
    ).toEqual({
      description: "Codex CLI subagent",
      detached: true,
    });
    expect(
      detectCodexCliSubagent("Bash", {
        command: "codex exec $(cat /tmp/prompt.md)",
      }),
    ).toEqual({
      description: "Codex CLI subagent",
      detached: false,
    });
  });

  it("does not assign one Bash lifecycle to multiple Codex launches", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command: 'codex exec "First worker assignment." & codex exec "Second worker assignment." &',
      }),
    ).toBeNull();
  });

  it("does not call a foreground launch detached because a later command backgrounds work", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command: 'codex exec "Run checks"; sleep 10 &',
      }),
    ).toMatchObject({ detached: false });
  });

  it("does not mistake prose, grep, or another tool for a Codex launch", () => {
    expect(detectCodexCliSubagent("Read", { command: 'codex exec "work"' })).toBeNull();
    expect(detectCodexCliSubagent("Bash", { command: 'echo "codex exec work"' })).toBeNull();
    expect(detectCodexCliSubagent("Bash", { command: "rg 'codex exec' docs" })).toBeNull();
    expect(
      detectCodexCliSubagent("Bash", { command: "codex exec --help 2>&1 | head -40" }),
    ).toBeNull();
  });

  it("does not call ordinary redirection detached", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command: 'codex exec "Run checks" > /tmp/codex.log 2>&1',
      }),
    ).toMatchObject({ detached: false });
  });

  it("uses an honest generic label when exec reads its prompt from stdin", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command: "codex exec --json - < /tmp/prompt.md",
      }),
    ).toEqual({
      description: "Codex CLI subagent",
      detached: false,
    });
  });

  it("recognizes resume --last without inventing a prompt", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command: "codex exec -C phase2-router resume --last",
      }),
    ).toEqual({
      description: "Resume Codex CLI subagent",
      cwd: "phase2-router",
      resumeLast: true,
      detached: false,
    });
  });

  it("parses resume follow-up text and cwd without treating them as a new rollout", () => {
    expect(
      detectCodexCliSubagent("Bash", {
        command:
          'cd /work && nohup codex exec -C . resume --last "A corrective follow-up." > /tmp/out 2>&1 &',
      }),
    ).toEqual({
      description: "Resume Codex CLI subagent",
      prompt: "A corrective follow-up.",
      shellCwd: "/work",
      cwd: ".",
      resumeLast: true,
      detached: true,
    });
  });
});
